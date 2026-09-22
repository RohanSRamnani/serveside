import { NonRetriableError, type GetStepTools } from 'inngest'
import { eq } from 'drizzle-orm'
import { locations } from '@/db/schema'
import { withLocation, isUuid } from '@/repo/scoped'
import { ordersRepo } from '@/repo/orders-repo'
import { isOpenAt } from '@/domain/hours'
import { sendSms } from '@/lib/sms'
import { env } from '@/lib/env'
import { inngest, ORDER_CREATED, type OrderCreatedData } from './client'

/**
 * The order nobody tapped Accept on.
 *
 * The fan-out told a kitchen an order exists. This is what happens when that was not
 * enough: the tablet is face-down on a shelf, the printer is out of paper, the one
 * person who watches the screen is at the pass. Twenty minutes later a customer
 * arrives for food that was never started, and the first anyone hears of it is an
 * argument at the counter.
 *
 * **It rides the `order/created` event rather than an event of its own.** Both ways
 * an order reaches NEW already emit exactly one: the Stripe webhook when a card
 * payment lands, and `POST /api/orders` when a pay-at-pickup order is placed. A
 * second event would be a second thing to remember to send — and the one place it
 * would be forgotten is the path that was only just fixed. Two functions on one event
 * is Inngest's ordinary shape; they get separate runs, separate retries and separate
 * failures.
 *
 * Three rules hold it up:
 *
 * 1. **The restaurant is paged first and we are paged second.** They can fix this in
 *    one tap and we cannot cook. Ops only hears about it once the owner has been told
 *    and has still done nothing four minutes later — so our phone ringing means "they
 *    are not reachable", which is a different job (phone the restaurant) than the
 *    owner's text ("tap Accept").
 * 2. **Accepting cancels the alarm by itself.** There is no cancel event and no
 *    bookkeeping: every leg re-reads the order, and one that has moved off NEW is one
 *    somebody is dealing with. A cancellation signal would be a second thing that can
 *    fail, and its failure mode is an owner texted about an order they served.
 * 3. **Nobody is woken for a closed restaurant.** Checked on *both* legs, not just the
 *    first: a kitchen that hit "we're slammed" between the two is a kitchen full of
 *    people who know exactly what they are doing, and a restaurant that shut at
 *    midnight is not a reason for anybody's phone to go off at 00:04. An alarm that
 *    fires when nothing can be done about it is an alarm that gets muted, and a muted
 *    alarm is worse than none.
 */

/**
 * How long a kitchen gets before its phone rings, and how long after that before ours
 * does. The numbers are the product decision, which is why they are exported and
 * pinned by a test rather than inlined.
 *
 * Six minutes is long enough that a kitchen mid-rush is not nagged over an order it is
 * already plating, and short enough that the customer is still ten minutes from the
 * door. Four more is one more look at the tablet.
 */
export const ACCEPT_GRACE = '6m' as const
export const OPS_ESCALATION = '4m' as const

/**
 * The same two waits as minutes, for the messages. Deliberately **the thresholds and
 * not elapsed time since `createdAt`**: an order's `created_at` is when the customer
 * hit pay, which on a card order can be minutes before the money landed and the
 * kitchen was told, so "waiting 9 min" would be counting time the kitchen never had.
 * What these two numbers say is exactly true — we waited this long and asked again.
 */
const OWNER_MINUTES = 6
const OPS_MINUTES = 10

/**
 * What one escalation came to. `no-longer-new` is the ordinary ending: somebody
 * tapped Accept.
 */
export type StaleOrderOutcome = 'no-longer-new' | 'closed' | 'gone' | 'owner-paged' | 'ops-paged'

export type StaleOrderResult = { orderId: string; outcome: StaleOrderOutcome }

export const staleOrderAlert = inngest.createFunction(
  { id: 'stale-order-alert', name: 'Stale order escalation', triggers: { event: ORDER_CREATED } },
  ({ event, step }) => escalateStaleOrder(event.data, step),
)

/**
 * The escalation itself, one step-tool short of being an Inngest function — split out
 * for the reason CLAUDE.md gives: `@inngest/test` settles a run at the first errored
 * step and never delivers a mocked failure to the function body, so the return value
 * and anything past a failure are only reachable with a `step` of the test's own
 * making.
 *
 * **Two `step.sleep`s, not one long one with a check in the middle**, because a sleep
 * is the unit Inngest makes durable: the run genuinely stops and is resumed by the
 * orchestrator ten minutes later, holding no connection, no timer and no process. The
 * re-reads then happen in their own steps, so a database blip at minute six is retried
 * on its own rather than replaying the wait.
 */
export async function escalateStaleOrder(
  data: unknown,
  step: GetStepTools<typeof inngest>,
): Promise<StaleOrderResult> {
  const { orderId, locationId } = staleTarget(data)

  await step.sleep('wait-for-accept', ACCEPT_GRACE)
  const first = await step.run('page-the-restaurant', () => page(orderId, locationId, 'owner'))
  // Anything but a page means the alarm is over: accepted, cancelled, closed, or an
  // order this location cannot see. Escalating past any of those is waking someone up
  // to tell them nothing is wrong.
  if (first !== 'owner-paged') return { orderId, outcome: first }

  await step.sleep('wait-for-ops', OPS_ESCALATION)
  return { orderId, outcome: await step.run('page-ops', () => page(orderId, locationId, 'ops')) }
}

/**
 * The ids out of the event payload, shape-checked — the same guard, for the same
 * reason, as the fan-out's. The payload arrives over HTTP from the orchestrator, so it
 * is input rather than a promise, and a malformed uuid reaching Postgres is a 22P02
 * that poisons the transaction it lands in. Non-retriable: an event that does not name
 * an order will not name one on the fourth attempt either.
 */
function staleTarget(data: unknown): OrderCreatedData {
  const { orderId, locationId } = (data ?? {}) as Partial<OrderCreatedData>
  if (typeof orderId !== 'string' || !isUuid(orderId) || typeof locationId !== 'string' || !isUuid(locationId)) {
    throw new NonRetriableError(`order/created without usable ids: ${JSON.stringify(data)}`)
  }
  return { orderId, locationId }
}

/**
 * One leg: look again, and ring a phone if the order really is still sitting there.
 *
 * Both legs are the same three questions in the same order — is it still NEW, is the
 * restaurant open, who gets told — which is why they are one function and not two that
 * have to be kept in step. The only difference is the number and the phone.
 */
async function page(orderId: string, locationId: string, who: 'owner' | 'ops'): Promise<StaleOrderOutcome> {
  const waiting = await stillWaiting(orderId, locationId)
  if (waiting.outcome) return waiting.outcome

  if (who === 'owner') {
    // The em dash is not in GSM-7, so this goes as UCS-2 and a segment is 70
    // characters rather than 160 — it fits, and a longer line added here would
    // silently become two messages. It names the tap that fixes it: a sentence read on
    // a phone between two other things has to say what to do, not that something is
    // wrong.
    await sendSms(
      waiting.phoneE164,
      `Order ${waiting.shortCode} has been waiting ${OWNER_MINUTES} min — tap Accept on the tablet`,
    )
    return 'owner-paged'
  }

  // Ours names the restaurant, because we have more than one, and says the owner has
  // already been texted — so the call we make is not the message they have just had.
  await sendSms(
    env('OPS_ALERT_E164'),
    `Serveside: ${waiting.name} has not accepted order ${waiting.shortCode} in ${OPS_MINUTES} min. `
    + 'Owner already texted.',
  )
  return 'ops-paged'
}

type StillWaiting =
  | { outcome: StaleOrderOutcome; shortCode?: undefined; phoneE164?: undefined; name?: undefined }
  | { outcome: null; shortCode: string; phoneE164: string; name: string }

/**
 * Is this order still unattended, and is there anybody to tell?
 *
 * One scoped transaction, so the order's status and the hours that decide whether to
 * page are read from one consistent view of the database — `isOpenAt` is handed the
 * `tx` for exactly that, and so it does not open a second pooled connection per leg.
 *
 * A missing order is `gone`, not an error: RLS filters rather than raising, so an
 * order in another location — or one deleted out from under us — simply is not there,
 * and there is nothing to tell anyone about it.
 */
async function stillWaiting(orderId: string, locationId: string): Promise<StillWaiting> {
  return withLocation(locationId, async (tx): Promise<StillWaiting> => {
    const order = await ordersRepo(tx).getById(orderId)
    if (!order) return { outcome: 'gone' }
    // Every status but NEW means a human has touched it — including REJECTED and
    // CANCELED, which are decisions, not neglect.
    if (order.status !== 'NEW') return { outcome: 'no-longer-new' }

    // Read now, not at the start of the run: the ten minutes this function sleeps
    // through are ten minutes in which a restaurant can close or hit pause.
    const open = await isOpenAt(locationId, new Date(), tx)
    if (!open.open) return { outcome: 'closed' }

    const [location] = await tx.select({ name: locations.name, phoneE164: locations.phoneE164 })
      .from(locations).where(eq(locations.id, locationId)).limit(1)
    // `locations` is the tenancy root and carries no RLS, so this is a real absence
    // rather than a scoping miss — and the order above could not have been read
    // without it. Non-retriable: it will be just as absent on the fourth attempt.
    if (!location) throw new NonRetriableError(`order/created names location ${locationId}, which does not exist`)

    return { outcome: null, shortCode: order.shortCode, phoneE164: location.phoneE164, name: location.name }
  })
}
