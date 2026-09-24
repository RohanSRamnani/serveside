import { NonRetriableError, type GetStepTools } from 'inngest'
import { and, desc, eq, max, ne, notInArray } from 'drizzle-orm'
import { db } from '@/db/client'
import { canaryRuns, locations, menuSnapshots, orderEvents, orders, printJobs } from '@/db/schema'
import type { SnapshotItem } from '@/db/schema'
import { withLocation } from '@/repo/scoped'
import { createOrder } from '@/domain/create-order'
import { transition, type OrderStatus } from '@/domain/order-status'
import { findCanaryLocation, type CanaryLocation } from '@/domain/canary'
import { syntheticPhone } from '@/lib/synthetic-phone'
import { sendSms } from '@/lib/sms'
import { env } from '@/lib/env'
import { inngest, sendOrderCreated } from './client'

/**
 * **The synthetic canary: a one-cent order every few minutes, to prove an order still
 * becomes a ticket.**
 *
 * Every other alarm here watches for a symptom — a printer gone quiet, an order nobody
 * accepted. This one exercises the cause: it places a real pay-at-pickup order at the
 * synthetic location through `createOrder`, announces it with the same
 * `sendOrderCreated` call `POST /api/orders` makes, waits, and checks that the real
 * fan-out put a ticket in `print_jobs`. If the order path, the Inngest event API, the
 * function registry, the orchestrator or the print leg is broken, this is what notices —
 * at 3am on a Tuesday as well as during service.
 *
 * Three properties keep it an instrument rather than a second source of alarms:
 *
 * 1. **It cleans up after every run** — the order is cancelled and the ticket removed, in
 *    a `clean-up` step that runs after the check whether the check found a ticket,
 *    found none, or threw. Otherwise the table fills with NEW orders, and on its eleventh
 *    failure of the day the canary would trip the unpaid-order cap and report an outage
 *    of its own making. Each run is also a new fictional customer (`syntheticPhone`), so
 *    even a run whose clean-up failed cannot count against the next.
 * 2. **It texts nobody but us, and us rarely.** The location is `synthetic`, so the
 *    fan-out, the stale-order alarm and the heartbeat all skip it. Ours rings on the
 *    second failure in a row — one failure is a Neon cold start — and then at most once
 *    an hour (`canary_runs.alerted_at`, the `printer_probe_events` shape).
 * 3. **One run at a time.** The clean-up cancels every open order at the synthetic
 *    location and removes every queued ticket there, which is only safe if no other
 *    canary run is mid-flight: `singleton: skip` drops a tick that finds one still
 *    running, and `timeouts.finish` stops a stuck run holding that lock for ever.
 *
 * **Inngest cost**, since Rohan picks the schedule before the deploy: a healthy run is
 * one run and five steps (place, wait, check, clean up, record) here, plus the fan-out it
 * triggers (one run, two steps) and the stale-order alarm (one run, no steps — it returns
 * before its first sleep for a synthetic location). Every five minutes is 288 ticks a day.
 */

/** The one place the schedule lives — every five minutes, per the plan. Every change to it is a change to the bill. */
export const CANARY_SCHEDULE = '*/5 * * * *' as const

/**
 * How long a ticket gets to appear. A healthy fan-out queues it within seconds of the
 * event; a minute also absorbs one retried print leg. Longer than this and the kitchen
 * is waiting too — which is a failure worth knowing about.
 */
export const CANARY_TICKET_WAIT = '1m' as const

/** One failure is a blip; two in a row is a page. */
export const CANARY_FAILURES_BEFORE_ALERT = 2

/** At most one text an hour — twelve failing runs, one text. */
export const CANARY_ALERT_COOLDOWN_MS = 60 * 60_000

/** Who the order is for. The phone is a fresh fictional one every run. */
const CANARY_CUSTOMER = 'Serveside canary'

/** On the cancelled order and in its audit row. Says who ended it and why. */
const CANARY_CANCEL_REASON = 'Synthetic canary order, cancelled by the canary after its ticket check.'

const TERMINAL: OrderStatus[] = ['COMPLETED', 'REJECTED', 'CANCELED']

export type CanaryResult = {
  runId: string
  orderId: string | null
  outcome: 'confirmed' | 'failed'
  /** Why the run failed, in words a person can act on. Null when it passed. */
  failure: string | null
  /** Whether this run texted `OPS_ALERT_E164`. */
  alerted: boolean
}

export type CanaryDeps = {
  /** The Inngest run id — the key a retried step finds its own run row by. */
  runId: string
  /** Where to order. Production finds the seeded canary; the suite hands in its own. */
  findLocation?: () => Promise<CanaryLocation>
}

/** What the placing step hands on. `locationId` null means there is nothing to clean up. */
type Placed = { locationId: string | null; orderId: string | null; failure: string | null }

export const canary = inngest.createFunction(
  {
    id: 'synthetic-canary-order',
    name: 'Synthetic canary order',
    triggers: { cron: CANARY_SCHEDULE },
    singleton: { mode: 'skip' },
    timeouts: { finish: '15m' },
  },
  ({ step, runId }) => runCanary(step, { runId }),
)

/**
 * One run, one step-tool short of an Inngest function — split out for the house reason
 * (`@inngest/test` never delivers a failed step to the function body, and the body's
 * handling of one is the whole of the clean-up guarantee).
 *
 * **The `try`s are the design.** A step that exhausts its retries reaches the body as a
 * thrown error. Caught, it becomes this run's failure reason and the run carries on to
 * `clean-up` — its own step, so its own retries — and then `record-outcome`, which
 * writes the verdict and decides whether to text. Only a failure to *record* is left to
 * throw, so Inngest retries it and, in the end, `SentryMiddleware` reports it: a canary
 * that cannot write down what happened is itself the thing to be told about.
 */
export async function runCanary(
  step: GetStepTools<typeof inngest>,
  { runId, findLocation = findCanaryLocation }: CanaryDeps,
): Promise<CanaryResult> {
  let placed: Placed
  try {
    placed = await step.run('place-order', () => placeCanaryOrder(runId, findLocation))
  } catch (err) {
    placed = { locationId: null, orderId: null, failure: `placing the order failed: ${describe(err)}` }
  }

  let failure = placed.failure
  const { locationId, orderId } = placed

  if (locationId && orderId && !failure) {
    try {
      await step.sleep('wait-for-ticket', CANARY_TICKET_WAIT)
      const ticket = await step.run('check-ticket', () => checkTicket(runId, locationId, orderId))
      if (!ticket.printJobId) failure = `no print job for order ${orderId} after ${CANARY_TICKET_WAIT}`
    } catch (err) {
      failure = `ticket check failed: ${describe(err)}`
    }
  }

  // Finally-shaped: whatever the check said, and whether or not it could say anything.
  if (locationId) {
    try {
      await step.run('clean-up', () => cleanUpCanary(locationId))
    } catch (err) {
      // A run that could not clean up broke the canary's own contract, so it is not
      // green even if the ticket arrived. The next run's clean-up sweeps what it left.
      failure ??= `clean-up failed: ${describe(err)}`
    }
  }

  const recorded = await step.run('record-outcome', () => recordCanaryOutcome(runId, failure))
  return { runId, orderId, failure, ...recorded }
}

/**
 * Open (or re-open) the run row, find the canary, place its order, announce it.
 *
 * **Idempotent per Inngest run**, because steps are at-least-once. The row is upserted on
 * `inngest_run_id`, so a retried step lands on the same row — and if that row already
 * names an order, the order is announced again (`sendOrderCreated` is idempotent per
 * order) rather than a second one placed. The one gap is a crash between the order's
 * commit and the row learning its id; the next run's clean-up sweeps that order.
 *
 * Expected failures come back as a value — no canary, a menu that cannot be ordered
 * from, `createOrder` refusing, the announce failing — so the run can still clean up and
 * record them. Only the run row itself failing to write is thrown.
 */
export async function placeCanaryOrder(
  runId: string,
  findLocation: () => Promise<CanaryLocation> = findCanaryLocation,
): Promise<Placed> {
  const [run] = await db().insert(canaryRuns)
    .values({ inngestRunId: runId })
    .onConflictDoUpdate({ target: canaryRuns.inngestRunId, set: { inngestRunId: runId } })
    .returning({ id: canaryRuns.id, locationId: canaryRuns.locationId, orderId: canaryRuns.orderId })

  if (run.locationId && run.orderId) return announce(run.locationId, run.orderId)

  const found = await findLocation()
  if (!found.ok) return { locationId: null, orderId: null, failure: found.reason }
  const { locationId } = found
  await db().update(canaryRuns).set({ locationId }).where(eq(canaryRuns.id, run.id))

  const line = await canaryLine(locationId)
  // A location that is not synthetic is refused outright, and handed on as no location
  // at all so the clean-up — which cancels every open order where it runs — never runs.
  if (!line.ok) return { locationId: line.refused ? null : locationId, orderId: null, failure: line.reason }

  let orderId: string
  try {
    const order = await createOrder({
      locationId,
      channel: 'web',
      fulfillment: 'pickup',
      contact: { name: CANARY_CUSTOMER, phone: syntheticPhone() },
      items: [{ menuItemId: line.menuItemId, qty: 1 }],
      tipCents: 0,
      payment: 'pay_on_pickup',
    })
    orderId = order.orderId
  } catch (err) {
    return { locationId, orderId: null, failure: `the order was refused: ${describe(err)}` }
  }

  await db().update(canaryRuns).set({ orderId }).where(eq(canaryRuns.id, run.id))
  return announce(locationId, orderId)
}

/**
 * The announce `POST /api/orders` makes for a pay-at-pickup order: the same function,
 * the same ids, the same time limit. A canary that announced its order any other way
 * would be proving a path no customer's order takes.
 */
async function announce(locationId: string, orderId: string): Promise<Placed> {
  try {
    await sendOrderCreated(orderId, locationId)
    return { locationId, orderId, failure: null }
  } catch (err) {
    return { locationId, orderId, failure: `the order could not be announced: ${describe(err)}` }
  }
}

/**
 * The dish to order, off the location's pinned menu — or why there is none.
 *
 * **Checks the location is synthetic first, in the same transaction**, whatever found
 * it: this function places real orders, and the canary's clean-up cancels every open
 * order at its location. A real restaurant must never be either.
 */
async function canaryLine(
  locationId: string,
): Promise<{ ok: true; menuItemId: string } | { ok: false; reason: string; refused: boolean }> {
  return withLocation(locationId, async (tx) => {
    const [location] = await tx.select({ synthetic: locations.synthetic })
      .from(locations).where(eq(locations.id, locationId)).limit(1)
    if (!location?.synthetic) {
      return { ok: false as const, refused: true, reason: `refusing to order from location ${locationId}: it is not synthetic` }
    }

    const [pinned] = await tx.select({ payload: menuSnapshots.payload }).from(menuSnapshots)
      .where(eq(menuSnapshots.locationId, locationId))
      .orderBy(desc(menuSnapshots.version))
      .limit(1)
    const item = pinned?.payload.categories.flatMap((category) => category.items).find(orderable)
    if (!item) {
      return {
        ok: false as const,
        refused: false,
        reason: `nothing on the canary's pinned menu can be ordered — run npm run seed:canary`,
      }
    }
    return { ok: true as const, menuItemId: item.id }
  })
}

/** On sale, and needing no choice from anybody. The seeded dish has no modifiers at all. */
function orderable(item: SnapshotItem): boolean {
  return !item.is86d && item.modifierGroups.every((group) => group.minSelect === 0)
}

/**
 * Did the fan-out queue a ticket for this order? Any status counts — nothing at a
 * synthetic location will ever move it off `queued`, but "a ticket exists" is the claim.
 * The id is written to the run **before** the clean-up deletes the row: it is the
 * evidence that the ticket was there.
 */
async function checkTicket(runId: string, locationId: string, orderId: string): Promise<{ printJobId: string | null }> {
  const [job] = await withLocation(locationId, (tx) => tx
    .select({ id: printJobs.id })
    .from(printJobs)
    .where(eq(printJobs.orderId, orderId))
    .limit(1))
  if (!job) return { printJobId: null }
  await db().update(canaryRuns).set({ printJobId: job.id }).where(eq(canaryRuns.inngestRunId, runId))
  return { printJobId: job.id }
}

/**
 * Cancel every open order at the synthetic location, and remove every queued ticket.
 *
 * **Every**, not just this run's, and on purpose: it sweeps what an earlier run could
 * not — a run whose clean-up failed, a placing step retried after its order committed,
 * a ticket a slow fan-out queued after the run that ordered it had already cleaned up.
 * With runs singleton, everything open or queued here is canary debris. Tickets are
 * **deleted** because `print_jobs` has no honest terminal status for one that was never
 * printed — `confirmed` means a printer said so — and a queued one here would sit in
 * `print_jobs_queued_idx` for ever, since no printer polls a synthetic location.
 *
 * Three guards, because this is the one destructive sweep in the codebase:
 *
 * - the location must be `synthetic`, read in the same transaction, or nothing happens;
 * - `withLocation`, so RLS confines every statement to this location;
 * - and **`location_id` is written into both statements as well**, the argued exception
 *   to the house rule that repos leave scoping to RLS: a sweep whose missing WHERE
 *   clause would cancel every restaurant's orders says whose rows in SQL too.
 *
 * Cancelled through the state machine (`transition`), with an event per order, like
 * every other state change.
 */
export async function cleanUpCanary(locationId: string): Promise<{ canceled: number; removedJobs: number }> {
  return withLocation(locationId, async (tx) => {
    const [location] = await tx.select({ synthetic: locations.synthetic })
      .from(locations).where(eq(locations.id, locationId)).limit(1)
    if (!location?.synthetic) {
      throw new NonRetriableError(`canary clean-up refused: location ${locationId} is not synthetic`)
    }

    const now = new Date()
    const open = await tx.select().from(orders)
      .where(and(eq(orders.locationId, locationId), notInArray(orders.status, TERMINAL)))
      .for('update')
    for (const order of open) {
      const { next, event } = transition(order, 'CANCELED', 'system')
      await tx.update(orders)
        .set({ status: next, canceledAt: now, cancelReason: CANARY_CANCEL_REASON })
        .where(eq(orders.id, order.id))
      await tx.insert(orderEvents).values({ orderId: order.id, ...event })
    }

    const removed = await tx.delete(printJobs)
      .where(and(eq(printJobs.locationId, locationId), eq(printJobs.status, 'queued')))
      .returning({ id: printJobs.id })
    return { canceled: open.length, removedJobs: removed.length }
  })
}

/**
 * Write the verdict, and text us if this is the second failure in a row and nobody has
 * been texted in the last hour.
 *
 * **Upserted on the run id**, so it records even a run whose placing step never managed
 * to open its row. **Recorded before the text is attempted, stamped after it lands** —
 * the heartbeat's order: a Twilio outage must not buy an hour of silence, so a failed
 * send throws, the step retries, and the retry finds the alarm still due.
 *
 * "In a row" is the runs that finished, newest first — a run that died without a verdict
 * is neither a success nor a failure. Its crash reached Sentry through the middleware.
 */
export async function recordCanaryOutcome(
  runId: string,
  failure: string | null,
): Promise<{ outcome: 'confirmed' | 'failed'; alerted: boolean }> {
  const now = new Date()
  const outcome = failure ? 'failed' : 'confirmed'
  await db().insert(canaryRuns)
    .values({ inngestRunId: runId, outcome, finishedAt: now, failureReason: failure })
    .onConflictDoUpdate({
      target: canaryRuns.inngestRunId,
      set: { outcome, finishedAt: now, failureReason: failure },
    })
  if (!failure) return { outcome, alerted: false }

  const earlier = await db().select({ outcome: canaryRuns.outcome }).from(canaryRuns)
    .where(and(ne(canaryRuns.inngestRunId, runId), ne(canaryRuns.outcome, 'running')))
    .orderBy(desc(canaryRuns.startedAt))
    .limit(CANARY_FAILURES_BEFORE_ALERT - 1)
  const inARow = earlier.length === CANARY_FAILURES_BEFORE_ALERT - 1
    && earlier.every((run) => run.outcome === 'failed')
  if (!inARow) return { outcome, alerted: false }

  const [{ lastAlertedAt }] = await db()
    .select({ lastAlertedAt: max(canaryRuns.alertedAt) })
    .from(canaryRuns)
  if (lastAlertedAt && now.getTime() - lastAlertedAt.getTime() < CANARY_ALERT_COOLDOWN_MS) {
    return { outcome, alerted: false }
  }

  await sendSms(env('OPS_ALERT_E164'), canaryAlert(failure))
  await db().update(canaryRuns).set({ alertedAt: now }).where(eq(canaryRuns.inngestRunId, runId))
  return { outcome, alerted: true }
}

/**
 * Ours alone, and it says what broke. GSM-7 only and bounded, so it stays one or two
 * segments whatever the failure text was.
 */
function canaryAlert(failure: string): string {
  const latest = failure.length > 90 ? `${failure.slice(0, 87)}...` : failure
  return `Serveside canary: ${CANARY_FAILURES_BEFORE_ALERT} synthetic orders in a row failed. Latest: ${latest}`
}

/** An error in one line — its code first when it has one (`unpaid_order_cap`, `23505`). */
function describe(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code
    return typeof code === 'string' ? `${code}: ${err.message}` : err.message
  }
  return String(err)
}
