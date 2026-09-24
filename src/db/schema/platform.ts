import { pgTable, pgEnum, uuid, text, integer, jsonb, timestamp, index } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { locations } from './tenancy'
import { orders } from './orders'

/**
 * Every webhook delivery we have ever accepted, one row each.
 *
 * **This table is the idempotency guard, not a log.** Stripe *will* deliver the
 * same event twice — on a retry, on a timeout it never saw our 200, on a replay
 * from the dashboard — and Twilio does the same. The insert of a row here is the
 * claim on an event: `INSERT ... ON CONFLICT DO NOTHING RETURNING id`, and zero
 * rows back means someone (us, a second ago, on another instance) already has it.
 * Handling only ever runs for the delivery that won the insert.
 *
 * `externalId` is therefore UNIQUE on its own rather than unique per provider.
 * Provider event ids are prefixed and globally unique (`evt_...`, `SM...`), so one
 * id space costs nothing — and it keeps the ON CONFLICT target a single column,
 * which is the statement that has to be obviously correct at 2am.
 *
 * **Platform-global, and deliberately exempt from RLS.** A webhook arrives before
 * anything knows which tenant it belongs to; the location is *inside* the payload.
 * There is nothing to scope the row to at the moment it must be written. The
 * handler opens `withLocation` for the order write, which is where tenancy is
 * enforced. Named in the catalog assertion in `src/repo/rls.test.ts` and in CLAUDE.md.
 */
export const webhookEvents = pgTable('webhook_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** `stripe` today, `twilio` next. Text, not an enum: a new provider is not worth a migration. */
  provider: text('provider').notNull(),
  /** The provider's own event id — `evt_...` for Stripe. The whole point of the table. */
  externalId: text('external_id').notNull().unique(),
  /** The event as delivered, verbatim. What forensics reads when a flip did not happen. */
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  /**
   * When this delivery was claimed. The insert **is** the claim, so claim and record
   * are one row written by one statement — there is no window in which an event is
   * half-claimed. The cost, named out loud: a handler that dies after the claim has
   * burnt the event, so the handler releases its claim (deletes the row) before it
   * returns a 5xx, and Stripe's retry gets a clean run.
   */
  processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * A kitchen printer. One row per physical unit.
 *
 * `serial` is the Star CloudPRNT printer's MAC address, which is what it sends on
 * every poll and the only identifier it has. UNIQUE across the platform, not per
 * location: a MAC belongs to exactly one printer, and the same unit registered at
 * two restaurants would print one kitchen's tickets in another.
 *
 * `lastSeenAt` is nullable — a printer that has never polled has never been seen —
 * and is what the "your printer is offline" heartbeat reads.
 */
export const printers = pgTable('printers', {
  id: uuid('id').primaryKey().defaultRandom(),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  /** `star_cloudprnt` today. Text for the same reason `webhookEvents.provider` is. */
  provider: text('provider').notNull(),
  serial: text('serial').notNull().unique(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  /**
   * When this printer last caused someone's phone to ring, and the whole of the
   * heartbeat's "at most one alert an hour" rule.
   *
   * A column rather than a dedupe table because the thing being rate-limited *is* a
   * printer: one row already exists per unit, it is the row the alert is about, and a
   * separate table would need its own tenancy policy to say the same thing. It covers
   * the stuck-ticket alert too — a `delivered` job that never printed is this
   * printer's silence by another name, and two alarms an hour about one dead printer
   * is how an owner learns to ignore both.
   *
   * Null means never alerted, which is every printer that has been behaving.
   */
  lastAlertAt: timestamp('last_alert_at', { withTimezone: true }),
}).enableRLS()

/**
 * The three states a ticket passes through, and why all three exist: CloudPRNT is a
 * **polling** protocol, so "we handed the bytes over" (`delivered`) and "the printer
 * says it printed" (`confirmed`) are different facts. A job stuck at `delivered` is
 * paper jammed or power pulled between the GET and the DELETE — which is exactly the
 * case an owner phones about.
 */
export const printJobStatus = pgEnum('print_job_status', ['queued', 'delivered', 'confirmed'])

/**
 * One rendered ticket, waiting for a printer to come and collect it.
 *
 * `payload` is the finished plain-text ticket, not a reference to the order:
 * `renderTicket` runs once, at fan-out, so a reprint three hours later reproduces
 * the ticket that was printed rather than re-rendering against a menu that has since
 * moved. Same reasoning as `orders.menu_snapshot_id`.
 *
 * Carries `locationId` of its own even though `orderId` implies it — the printer
 * poll asks "any queued job for *this location*" without a join, and it is the
 * column the RLS policy reads.
 */
export const printJobs = pgTable('print_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  orderId: uuid('order_id').notNull().references(() => orders.id),
  payload: text('payload').notNull(),
  status: printJobStatus('status').notNull().default('queued'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  /** Set when the printer confirms the print, never before. Null on `queued` and `delivered`. */
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
}, (t) => [
  /**
   * The index the CloudPRNT poll lives on, and the only one this table needs.
   *
   * Every printer on the platform runs exactly one query against this table, forever:
   * `WHERE location_id = ... AND status = 'queued' ORDER BY created_at, id LIMIT 1`,
   * every few seconds, per kitchen. Nothing prunes `print_jobs` — it is the record of
   * what was printed — so the table only grows, while the set of rows the poll wants
   * stays near zero. A sequential scan of a year of tickets to find that nothing is
   * waiting is a cost that compounds with every order ever taken.
   *
   * **Partial** for that reason: the predicate matches the query's own, so the index
   * holds only the handful of jobs actually queued rather than every ticket in
   * history. `location_id` leads because RLS adds that equality to every statement.
   */
  index('print_jobs_queued_idx')
    .on(t.locationId, t.createdAt)
    .where(sql`${t.status} = 'queued'`),
  /**
   * The same shape for the other transient state, and the heartbeat alarm lives on it:
   * "any ticket handed over and still not confirmed" runs per location, twelve times
   * an hour, forever — and the queued index above cannot serve it, because that one is
   * partial on `status = 'queued'` and this predicate is `delivered`.
   *
   * Partial for the same reason too. `delivered` is meant to last seconds (the printer
   * GETs, prints, DELETEs), so this index holds the jobs actually in flight plus the
   * stuck ones, rather than every ticket the restaurant has ever printed. Without it
   * the alarm is a sequential scan of a table that only ever grows, on a five-minute
   * timer, per kitchen.
   */
  index('print_jobs_delivered_idx')
    .on(t.locationId, t.createdAt)
    .where(sql`${t.status} = 'delivered'`),
]).enableRLS()

/**
 * One row per printer serial that has polled us and turned out to belong to nobody.
 *
 * It exists for one signal and one only: **serial enumeration**. The CloudPRNT route
 * is unauthenticated by protocol and the serial is the whole credential, so guessing
 * one is the attack — and the only trace it leaves is a spread of unknown serials
 * arriving at once. A genuine unknown serial is a mis-provisioned printer at install
 * time: one MAC, repeating, forever. Twenty distinct ones in ten minutes is a sweep.
 *
 * **Platform-global and exempt from RLS**, and this is a cleaner case than
 * `webhook_events`: a row here is by definition a serial that belongs to *no*
 * location. `printer_lookup` returned nothing — that is what put the row here — so
 * there is no tenant to scope it to, not merely one we have not read yet. Nothing in
 * it is a restaurant's data, and nothing about it can become a printer: this table has
 * no `location_id` and no path into `printers`. Named in CLAUDE.md and in the catalog
 * assertion in `src/repo/rls.test.ts`.
 *
 * **Unique on `serial`, which is what bounds it.** The poll path is unauthenticated,
 * so a row per request would be an unbounded write an attacker controls; an upsert
 * makes a sweep of N serials cost N rows once and a printer hammering us cost none.
 * `polls` and `firstSeenAt` are what tell the two apart at a glance.
 */
export const printerProbeEvents = pgTable('printer_probe_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Already clamped to `SERIAL` shape by the route before it ever reaches here. */
  serial: text('serial').notNull().unique(),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  /** Bumped on every poll. The burst query is `count(*) where last_seen_at > now() - 10m`. */
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  polls: integer('polls').notNull().default(1),
  /**
   * When this row was last part of an alert. The burst alarm's "one ops SMS an hour"
   * lives here rather than in a counter of its own: the rows in the window *are* the
   * alert, so stamping them is the record that it was sent.
   */
  alertedAt: timestamp('alerted_at', { withTimezone: true }),
}, (t) => [
  // The only query this table serves: the rows seen inside the burst window.
  index('printer_probe_events_last_seen_idx').on(t.lastSeenAt),
])

/** Where one canary run got to. `running` is a run that has not recorded its verdict yet — or died before it could. */
export const canaryOutcome = pgEnum('canary_outcome', ['running', 'confirmed', 'failed'])

/**
 * One row per run of the synthetic canary (`src/inngest/canary.ts`): a one-cent order
 * placed at the synthetic location through `createOrder`, announced the way the route
 * announces one, and checked for a ticket in `print_jobs` a minute later.
 *
 * **Platform-global and exempt from RLS**, and the reason is the failure it has to be
 * able to record. The run row is written *before* the canary location is looked up, so
 * "there is no canary location" — never seeded, or seeded wrongly — is itself a run
 * that failed, and two of those in a row page us like any other. A row that had to be
 * scoped to the canary location could not exist in exactly the case where the canary is
 * most broken. It is also not a restaurant's data: it holds ids, timestamps and our own
 * failure text, and its readers are the canary itself and whoever is on call. Named in
 * `src/repo/rls.test.ts` and CLAUDE.md with the other exemptions.
 *
 * - `inngestRunId` is UNIQUE because Inngest steps are at-least-once: the step that
 *   places the order upserts on it, so a retried step lands on the same row and finds
 *   the order it already placed instead of placing a second one. It is also the handle
 *   that finds the run in the Inngest dashboard.
 * - `printJobId` has **no foreign key, on purpose**: the run records the ticket it saw
 *   and then deletes that ticket (a synthetic location has no printer, so a queued job
 *   there would wait forever in `print_jobs_queued_idx`). The id is the evidence.
 * - `alertedAt` is the "one text an hour" rule, in the `printer_probe_events` shape:
 *   the run that texted us is stamped after the text went out, and the cooldown is
 *   `max(alerted_at)`. Deliberately its own state, never shared with another alarm — a
 *   canary text must not buy a Stripe outage an hour of silence.
 */
export const canaryRuns = pgTable('canary_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  inngestRunId: text('inngest_run_id').notNull().unique(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  outcome: canaryOutcome('outcome').notNull().default('running'),
  locationId: uuid('location_id').references(() => locations.id),
  orderId: uuid('order_id').references(() => orders.id),
  printJobId: uuid('print_job_id'),
  failureReason: text('failure_reason'),
  alertedAt: timestamp('alerted_at', { withTimezone: true }),
}, (t) => [
  /** "The runs before this one", newest first — the consecutive-failure question. */
  index('canary_runs_started_idx').on(t.startedAt),
  /** Partial: the cooldown's `max(alerted_at)` reads the handful of runs that ever texted. */
  index('canary_runs_alerted_idx').on(t.alertedAt).where(sql`${t.alertedAt} is not null`),
])

/**
 * Every card order that was converted to pay-at-pickup because Stripe could not be
 * reached (`failOverToPickup` in `src/app/api/orders/route.ts`), one row each, written
 * **inside the conversion's own transaction** — so a converted order without a row here
 * cannot exist, and neither can a row for a conversion that rolled back.
 *
 * It exists for the alarm: a Stripe outage used to leave one `console.error` per
 * converted order and nothing else. The route sends `payments/stripe-outage` after the
 * commit, and `src/inngest/stripe-outage-alert.ts` texts `OPS_ALERT_E164` at most once an
 * hour, in the `printer_probe_events` shape — the row that raised the text is stamped
 * `alerted_at` after the send, and the cooldown is `max(alerted_at)`.
 *
 * **Platform-global and exempt from RLS**, because the question it answers is
 * platform-wide: Stripe is one dependency for every restaurant, so one outage is one
 * text an hour, not one per restaurant per hour — and a cooldown that could only see one
 * location's rows would be exactly the second. Nothing in it is a restaurant's data
 * beyond ids (no amounts, no customer, no error text). Named in `src/repo/rls.test.ts`
 * and CLAUDE.md. `orderId` is UNIQUE: an order leaves PENDING_PAYMENT once, so it can
 * be converted at most once.
 */
export const paymentFailovers = pgTable('payment_failovers', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id').notNull().unique().references(() => orders.id),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  alertedAt: timestamp('alerted_at', { withTimezone: true }),
}, (t) => [
  /** "How many in the last hour", for the text itself. */
  index('payment_failovers_created_idx').on(t.createdAt),
  /** Partial, like the canary's: the cooldown reads only rows that ever texted. */
  index('payment_failovers_alerted_idx').on(t.alertedAt).where(sql`${t.alertedAt} is not null`),
])

export type WebhookEvent = typeof webhookEvents.$inferSelect
export type Printer = typeof printers.$inferSelect
export type PrintJob = typeof printJobs.$inferSelect
export type PrinterProbeEvent = typeof printerProbeEvents.$inferSelect
export type CanaryRun = typeof canaryRuns.$inferSelect
export type PaymentFailover = typeof paymentFailovers.$inferSelect
