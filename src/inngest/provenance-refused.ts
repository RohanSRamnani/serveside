import { NonRetriableError, type GetStepTools } from 'inngest'
import { isUuid } from '@/repo/scoped'
import { sendSms } from '@/lib/sms'
import { env } from '@/lib/env'
import { inngest, PROVENANCE_REFUSED, type ProvenanceRefusedData } from './client'

/**
 * Somebody tried to pay for an order with money that was not for it.
 *
 * The Stripe webhook already refuses these — wrong connected account, wrong amount —
 * and refusing is the part that protects the restaurant. What was missing is anyone
 * finding out: the refusal was a `console.error` on a serverless function, which is a
 * line in a log nobody reads until they are already looking for it. These checks exist
 * because the attack is real (every restaurant on the platform can mint a
 * PaymentIntent carrying any metadata it likes), so one of them firing is news.
 *
 * **Ops only, never the restaurant.** The owner can do nothing about this and does not
 * need a text saying someone may be probing their payments; and if the refusal is our
 * bug instead — an intent created with the wrong metadata, a Connect webhook
 * registered on the wrong account, which would refuse *every* payment — then telling
 * the restaurant "a payment was refused" is alarming and useless in the same sentence.
 * Either way the next step is ours: open the Stripe dashboard and look.
 *
 * One step, so a Twilio outage retries the text rather than the whole decision.
 */
export const provenanceRefused = inngest.createFunction(
  { id: 'provenance-refused-alert', name: 'Payment provenance refused', triggers: { event: PROVENANCE_REFUSED } },
  ({ event, step }) => alertProvenanceRefused(event.data, step),
)

/** Split out for the house reason: `@inngest/test` cannot reach a function's return value. */
export async function alertProvenanceRefused(
  data: unknown,
  step: GetStepTools<typeof inngest>,
): Promise<{ orderId: string; reason: string }> {
  const refusal = refusedTarget(data)
  await step.run('sms-ops', () => sendSms(
    env('OPS_ALERT_E164'),
    `Payment provenance refused for order ${refusal.orderId} — investigate`,
  ))
  return { orderId: refusal.orderId, reason: refusal.reason }
}

/**
 * The payload, shape-checked. Nothing here reaches a query — the message is the whole
 * job — but the id goes into a text message a human then pastes into a dashboard, and
 * an event that does not name an order is not worth waking anyone for. Non-retriable:
 * it will not name one on the fourth attempt either.
 */
function refusedTarget(data: unknown): ProvenanceRefusedData {
  const { orderId, locationId, reason } = (data ?? {}) as Partial<ProvenanceRefusedData>
  if (typeof orderId !== 'string' || !isUuid(orderId)
    || typeof locationId !== 'string' || !isUuid(locationId)
    || (reason !== 'account_mismatch' && reason !== 'amount_mismatch')) {
    throw new NonRetriableError(`payments/provenance-refused without usable data: ${JSON.stringify(data)}`)
  }
  return { orderId, locationId, reason }
}
