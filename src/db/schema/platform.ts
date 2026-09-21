import { pgTable, pgEnum, uuid, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core'
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
 * and is what Task 14's "your printer is offline" alert reads.
 */
export const printers = pgTable('printers', {
  id: uuid('id').primaryKey().defaultRandom(),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  /** `star_cloudprnt` today. Text for the same reason `webhookEvents.provider` is. */
  provider: text('provider').notNull(),
  serial: text('serial').notNull().unique(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
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
]).enableRLS()

export type WebhookEvent = typeof webhookEvents.$inferSelect
export type Printer = typeof printers.$inferSelect
export type PrintJob = typeof printJobs.$inferSelect
