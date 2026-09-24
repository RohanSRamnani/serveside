import { NonRetriableError, type GetStepTools } from 'inngest'
import { count, eq, gt, max } from 'drizzle-orm'
import { db } from '@/db/client'
import { paymentFailovers } from '@/db/schema'
import { isUuid } from '@/repo/scoped'
import { sendSms } from '@/lib/sms'
import { env } from '@/lib/env'
import { inngest, STRIPE_OUTAGE, type StripeOutageData } from './client'

/**
 * **Stripe has stopped answering, and card orders are being taken at the counter.**
 *
 * `POST /api/orders` survives a Stripe outage by converting a card order it cannot open
 * an intent for into a pay-at-pickup one (`failOverToPickup`), and that is exactly why
 * this alarm has to exist: the failover is silent by design. An outage that lasts the
 * evening is a restaurant collecting every card order's money at the counter — and
 * possibly never collecting some of it — while nobody on our side knows. Until now the
 * only trace was one `console.error` per converted order.
 *
 * Each conversion writes a `payment_failovers` row in its own transaction, and the route
 * then sends `payments/stripe-outage` with the ids. This texts `OPS_ALERT_E164`:
 *
 * - **Us, never the restaurant.** Their customers were served; the fix is on our side
 *   (or Stripe's), and the owner's counter staff find out from the ticket anyway.
 * - **At most once an hour, for the whole platform** — Stripe is one dependency for
 *   every restaurant, so one outage is one page, not one per restaurant. The
 *   `printer_probe_events` shape: `max(alerted_at)` across every conversion is the
 *   cooldown, and the conversion that raised the text is stamped. Its own state, never
 *   the canary's — a canary page must not buy a Stripe outage an hour of silence.
 * - **Send, then stamp** — the heartbeat's order. A failed send throws, the step
 *   retries, and the retry finds the alarm still due; stamping first would let a Twilio
 *   outage buy an hour of silence about a Stripe one.
 * - **One run at a time** (`concurrency: 1`). An outage converts every card order at
 *   once, and without it a burst of runs could all read "nothing sent in the last hour"
 *   before any of them stamped. Serialised, the first stamps before the second reads.
 *   Configuration, not a second cooldown: the hour is still the table's.
 */
export const STRIPE_OUTAGE_ALERT_COOLDOWN_MS = 60 * 60_000

export const stripeOutageAlert = inngest.createFunction(
  {
    id: 'stripe-outage-alert',
    name: 'Stripe outage alert',
    triggers: { event: STRIPE_OUTAGE },
    concurrency: { limit: 1 },
  },
  ({ event, step }) => alertStripeOutage(event.data, step),
)

/** Split out for the house reason: `@inngest/test` cannot reach past a failed step. */
export async function alertStripeOutage(
  data: unknown,
  step: GetStepTools<typeof inngest>,
): Promise<{ orderId: string; alerted: boolean }> {
  const { orderId } = outageTarget(data)
  const alerted = await step.run('sms-ops-once-an-hour', () => textOpsOnceAnHour(orderId))
  return { orderId, alerted }
}

async function textOpsOnceAnHour(orderId: string): Promise<boolean> {
  const now = new Date()

  // The row this event is about — written by the conversion, in its own transaction,
  // before the event was sent. An event that names no recorded conversion is not
  // something to wake anyone for, and it would have no row to stamp.
  const [conversion] = await db().select({ id: paymentFailovers.id })
    .from(paymentFailovers).where(eq(paymentFailovers.orderId, orderId)).limit(1)
  if (!conversion) throw new NonRetriableError(`payments/stripe-outage names order ${orderId}, which was never converted`)

  const [{ lastAlertedAt }] = await db()
    .select({ lastAlertedAt: max(paymentFailovers.alertedAt) })
    .from(paymentFailovers)
  if (lastAlertedAt && now.getTime() - lastAlertedAt.getTime() < STRIPE_OUTAGE_ALERT_COOLDOWN_MS) return false

  // How bad, in one number: every conversion on the platform in the last hour.
  const [{ converted }] = await db()
    .select({ converted: count() })
    .from(paymentFailovers)
    .where(gt(paymentFailovers.createdAt, new Date(now.getTime() - STRIPE_OUTAGE_ALERT_COOLDOWN_MS)))

  await sendSms(env('OPS_ALERT_E164'), outageMessage(converted))
  await db().update(paymentFailovers).set({ alertedAt: now }).where(eq(paymentFailovers.id, conversion.id))
  return true
}

/**
 * What to do next, in one GSM-7 segment: Stripe's status page for whether it is them,
 * Sentry for the errors themselves (every conversion is an event there).
 */
function outageMessage(converted: number): string {
  return `Serveside: Stripe is failing. ${converted} card order${converted === 1 ? '' : 's'}`
    + ' switched to pay at pickup in the last hour. Check Sentry and status.stripe.com.'
}

/** Ids only, shape-checked — the payload arrives over HTTP from the orchestrator. */
function outageTarget(data: unknown): StripeOutageData {
  const { orderId, locationId } = (data ?? {}) as Partial<StripeOutageData>
  if (typeof orderId !== 'string' || !isUuid(orderId) || typeof locationId !== 'string' || !isUuid(locationId)) {
    throw new NonRetriableError(`payments/stripe-outage without usable ids: ${JSON.stringify(data)}`)
  }
  return { orderId, locationId }
}
