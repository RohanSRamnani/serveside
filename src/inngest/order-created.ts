import { NonRetriableError, type GetStepTools } from 'inngest'
import { eq, sql } from 'drizzle-orm'
import { locations, printJobs } from '@/db/schema'
import { withLocation, isUuid, type ScopedTx } from '@/repo/scoped'
import { ordersRepo } from '@/repo/orders-repo'
import { renderTicket } from '@/domain/ticket'
import { formatCents } from '@/lib/money'
import { sendSms } from '@/lib/sms'
import { env } from '@/lib/env'
import { inngest, ORDER_CREATED, type OrderCreatedData } from './client'

/**
 * The order fan-out: money landed, so a human finds out.
 *
 * Two legs, and **the independence between them is the entire design**. A kitchen
 * whose printer is jammed still gets the text; a restaurant whose Twilio account has
 * run dry still gets the ticket. They are two `step.run`s rather than two lines in
 * one, because a step is the unit Inngest retries and memoizes: separate steps means
 * separate retry ladders, and a leg that has already succeeded is never repeated when
 * the other one is retried.
 *
 * `Promise.allSettled`, not `await` then `await`, and not `Promise.all`:
 *
 * - Sequential would make the SMS wait out the print leg's entire retry ladder — the
 *   owner's phone is the backstop *for* a failing printer path, so it must not be
 *   queued behind it.
 * - `Promise.all` would reject at the first failure and leave the other leg's result
 *   unread; `allSettled` lets both finish and then reports what broke.
 *
 * **The run still fails when a leg does**, deliberately. A half-done fan-out that
 * reports success is a failed print job nobody is ever told about; a red run is what
 * a human goes and looks at in the dashboard.
 *
 * And it is not the only backstop: `stale-order-alert` rides this same event in a run
 * of its own, so a fan-out that failed *entirely* — no ticket, no text — still ends
 * with the owner's phone ringing six minutes later, because the order is still sitting
 * at NEW. The two are independent by construction: a second function on one event
 * cannot be taken down by the first one's failure.
 *
 * That throw costs nothing but visibility, and the installed SDK is where that is
 * checked rather than assumed. `node_modules/inngest/components/StepError.d.ts`: a
 * `StepError` "represents a step exhausting all retries and failing… thrown by an
 * Inngest step if it fails" — so the body really is resumed with the failure, which is
 * the only path that reaches the throw. And
 * `node_modules/inngest/components/execution/engine.js` (~1464) replays a memoized
 * failure as `setActualHandler(() => Promise.reject(stepError))` — the callback is
 * **not** re-run. So the function-level retries this throw provokes re-run the body
 * only: no second text, no second ticket, just a run that ends red.
 *
 * What the two legs *do* share is the order row: neither a ticket nor a text can be
 * produced without it. An unreadable order therefore fails both, which is not a
 * coupling but a prerequisite — there is nothing to tell anyone.
 */
export const orderCreated = inngest.createFunction(
  { id: 'order-created-fan-out', name: 'Order fan-out', triggers: { event: ORDER_CREATED } },
  ({ event, step }) => fanOut(event.data, step),
)

/**
 * The fan-out itself, one step-tool short of being an Inngest function.
 *
 * Split out from `createFunction` so it can be called with a `step` of the test's own
 * making. That is not a convenience: `@inngest/test@1.0.0` reports a run as failed the
 * moment a step errors and never resumes the function body, and a *mocked* failed step
 * is swallowed rather than delivered — so through the harness alone, neither the throw
 * below nor this function's return value can be reached at all. A two-line fake `step`
 * reaches both.
 */
export async function fanOut(
  data: unknown,
  step: GetStepTools<typeof inngest>,
): Promise<{ orderId: string; printJobId?: string; alreadyQueued?: boolean }> {
  const { orderId, locationId } = fanOutTarget(data)

  const [print, sms] = await Promise.allSettled([
    step.run('queue-print-job', () => queuePrintJob(orderId, locationId)),
    step.run('sms-owner', () => smsOwner(orderId, locationId)),
  ])

  const incomplete = fanOutFailure(orderId, print, sms)
  if (incomplete) throw new Error(incomplete)

  // Narrowing: `fanOutFailure` returning null means neither leg rejected, but the
  // compiler cannot know that, so the check is repeated here rather than cast away.
  return print.status === 'fulfilled' ? { orderId, ...print.value } : { orderId }
}

/** Which legs failed, as one line — or `null` when the fan-out is whole. */
function fanOutFailure(
  orderId: string,
  print: PromiseSettledResult<unknown>,
  sms: PromiseSettledResult<unknown>,
): string | null {
  const failures = [
    print.status === 'rejected' ? `queue-print-job: ${describe(print.reason)}` : null,
    sms.status === 'rejected' ? `sms-owner: ${describe(sms.reason)}` : null,
  ].filter((failure): failure is string => failure !== null)

  // Both legs naming themselves, even when both broke: "the fan-out failed" is not an
  // actionable sentence at 7pm on a Friday, and which half reached a human is the
  // first thing anyone needs to know.
  return failures.length === 0 ? null : `order ${orderId} fan-out incomplete — ${failures.join('; ')}`
}

/**
 * The ids out of the event payload, shape-checked.
 *
 * The payload arrives over HTTP from the orchestrator, so it is input rather than a
 * promise — and a malformed uuid reaching Postgres is a 22P02 that poisons the whole
 * transaction, which is why the Stripe webhook checks its metadata the same way.
 * Non-retriable: an event that does not name an order will not name one on the fourth
 * attempt either.
 */
function fanOutTarget(data: unknown): OrderCreatedData {
  const { orderId, locationId } = (data ?? {}) as Partial<OrderCreatedData>
  if (typeof orderId !== 'string' || !isUuid(orderId) || typeof locationId !== 'string' || !isUuid(locationId)) {
    throw new NonRetriableError(`order/created without usable ids: ${JSON.stringify(data)}`)
  }
  return { orderId, locationId }
}

/**
 * The kitchen's copy: render the ticket and put it in the queue the printer polls.
 *
 * **Idempotent per order**, and it has to be: the webhook re-fires a fan-out it could
 * not prove landed, and Inngest's event-id dedupe only covers 24 hours. A second row
 * here is a second ticket, which is a second dinner. Reprinting is re-collecting this
 * same job (the CloudPRNT GET serves a `delivered` one again), never a new row — so
 * "one queued ticket per order" is the right invariant and not a limitation.
 *
 * A check followed by an insert is not atomic under READ COMMITTED, and **Inngest is
 * at-least-once** — a step can genuinely run twice, concurrently, after a lost
 * response — so the pair is serialised per order by a transaction-scoped advisory
 * lock. The loser then sees the row and skips. The alternative, a UNIQUE index on
 * `print_jobs.order_id`, would also close it but decides for all time that an order
 * can never have a second ticket; the lock leaves that open.
 */
async function queuePrintJob(
  orderId: string,
  locationId: string,
): Promise<{ printJobId: string; alreadyQueued: boolean }> {
  return withLocation(locationId, async (tx) => {
    // Keyed on the order, so two fan-outs of *different* orders never wait on each
    // other; a hash collision costs one short wait and nothing else. `_xact_` — it is
    // released by the commit, which is what makes it safe on a pooled connection.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${orderId}::text, 0))`)

    const [existing] = await tx.select({ id: printJobs.id }).from(printJobs)
      .where(eq(printJobs.orderId, orderId)).limit(1)
    if (existing) return { printJobId: existing.id, alreadyQueued: true }

    const order = await ordersRepo(tx).getWithItems(orderId)
    if (!order) throw missing(orderId, locationId)

    // The ticket is rendered **once, here**, and stored verbatim — the same reasoning
    // as `orders.menu_snapshot_id`. A reprint three hours from now must reproduce the
    // ticket that printed, not re-render against a menu that has moved.
    const { timezone } = await locationFor(tx, locationId)
    const payload = renderTicket({ ...order, timezone })

    const [job] = await tx.insert(printJobs)
      .values({ locationId, orderId, payload })
      .returning({ id: printJobs.id })
    return { printJobId: job.id, alreadyQueued: false }
  })
}

/**
 * The owner's copy: the short code, the money, and a link to the feed.
 *
 * Deliberately **not** deduped, and the asymmetry is the point. A duplicate text is a
 * nuisance; a duplicate ticket is food. Gating the text on the print job's existence
 * would couple the two legs — the one thing this function may not do.
 *
 * Returns nothing: step output is stored by Inngest, and a phone number in it is our
 * customer's restaurant sitting in a third party's dashboard for no reason.
 */
async function smsOwner(orderId: string, locationId: string): Promise<void> {
  const { shortCode, totalCents, phoneE164 } = await withLocation(locationId, async (tx) => {
    // The lines are not needed here, so this is the cheap read — `getById`, not
    // `getWithItems`.
    const order = await ordersRepo(tx).getById(orderId)
    if (!order) throw missing(orderId, locationId)
    const { phoneE164 } = await locationFor(tx, locationId)
    return { shortCode: order.shortCode, totalCents: order.totalCents, phoneE164 }
  })

  // `formatCents`, never `totalCents / 100`: money is integer cents in this repo and
  // a float divide is a second, lossy opinion on a number that was already exact.
  //
  // The `—` is an em dash, which is not in GSM-7, so the message is sent as UCS-2 and
  // a segment is 70 characters rather than 160. It fits — `New order K7M2 — $45.24.
  // Feed: <url>` is well under that — but a longer line added here would silently
  // become two segments and two billed messages.
  await sendSms(phoneE164, `New order ${shortCode} — $${formatCents(totalCents)}. Feed: ${env('FEED_URL')}`)
}

/**
 * The two things the fan-out needs from the location itself: the wall clock a ticket
 * prints in, and the phone a text goes to. Neither is on the order row.
 *
 * `locations` is not under RLS, but this reads it on the scoped `tx` anyway, so the
 * timezone a ticket is stamped with and the order it was rendered from come out of one
 * consistent view of the database.
 */
async function locationFor(tx: ScopedTx, locationId: string): Promise<{ timezone: string; phoneE164: string }> {
  const [location] = await tx.select({ timezone: locations.timezone, phoneE164: locations.phoneE164 })
    .from(locations).where(eq(locations.id, locationId)).limit(1)
  if (!location) throw new NonRetriableError(`order/created names location ${locationId}, which does not exist`)
  return location
}

/**
 * RLS filters rather than raising, so an order in another location reads as "not
 * there" — and it will read that way forever, which is why this is non-retriable
 * rather than four attempts at a row that does not exist.
 */
function missing(orderId: string, locationId: string): NonRetriableError {
  return new NonRetriableError(`order/created names order ${orderId}, which is not in location ${locationId}`)
}

/** A rejected leg's reason, flattened for one line of a failure message. */
function describe(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
