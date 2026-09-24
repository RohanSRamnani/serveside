import { Inngest } from 'inngest'
import { withTimeout } from '@/lib/with-timeout'
import { SentryMiddleware } from './sentry-middleware'

/**
 * The Inngest client, and the events this app sends.
 *
 * Inngest is here for one property: **durable steps**. The order fan-out has to keep
 * going when a leg of it fails, and it has to be able to fail in the middle and
 * resume without repeating what already succeeded. That is not something a
 * `Promise.all` after the webhook's 200 can do.
 *
 * `SentryMiddleware` is how a run that failed for good reaches Sentry: Inngest catches a
 * function's errors itself, so Next's `onRequestError` never sees them.
 */
export const inngest = new Inngest({ id: 'serveside', middleware: [SentryMiddleware] })

/**
 * The events in the system. Consts because a sender and a trigger that drift apart
 * compile, serve, and deliver nothing, forever.
 *
 * `order/created` has **two** listeners: the fan-out that tells a kitchen, and the
 * stale-order escalation that notices when the kitchen did nothing about it. One
 * event, because both ways an order reaches NEW already send exactly one — and a
 * second event would be a second thing to remember to fire.
 */
export const ORDER_CREATED = 'order/created' as const
export const PROVENANCE_REFUSED = 'payments/provenance-refused' as const
export const STRIPE_OUTAGE = 'payments/stripe-outage' as const

/**
 * **How long any send may take before it counts as failed.** Five seconds.
 *
 * Every send in this app happens *after* the thing it announces has committed, so the
 * cost of a hung one is not a slow request — it is the platform's function timeout
 * killing the request mid-wait. On `POST /api/orders` (`maxDuration = 60`) that told a
 * customer nothing was ordered for an order already on the kitchen's board, and their
 * retry was a second dinner. Bounded here, once, every caller gets the ordinary thrown
 * failure it already handles: the route logs it (and Sentry hears) and answers 200; the
 * Stripe webhook releases its claim and answers 5xx, so Stripe retries into the re-fire
 * path; the canary records a failed run.
 *
 * Five seconds is two orders of magnitude over a healthy send and a small slice of the
 * order route's budget, which its own test pins.
 */
export const INNGEST_SEND_TIMEOUT_MS = 5_000

/**
 * The one way this app sends an event: `inngest.send` under {@link INNGEST_SEND_TIMEOUT_MS}.
 * A send that times out may still have been delivered — every event here carries an `id`,
 * so the retry a caller makes of it is deduplicated by Inngest, never doubled.
 */
async function send(event: { name: string; data: Record<string, unknown>; id: string }): Promise<string[]> {
  const { ids } = await withTimeout(inngest.send(event), INNGEST_SEND_TIMEOUT_MS, `inngest.send(${event.name})`)
  return ids
}

/**
 * What the fan-out is told. Deliberately **ids only** — no order body, no totals, no
 * customer name.
 *
 * Two reasons, and neither is style. An event payload is stored by Inngest and shown
 * in its dashboard, so a customer's name and phone number in here is our data sitting
 * in a third party's UI for no reason. And an event is a snapshot: a worker that
 * re-reads the order gets the row as it is *now*, which is the only version worth
 * printing.
 *
 * `locationId` travels with the order id rather than being looked up, and that is
 * load-bearing: every order read goes through `withLocation`, and a worker holding
 * only an `orderId` has no scope to open — RLS would hide the row from it completely.
 */
export type OrderCreatedData = { orderId: string; locationId: string }

/**
 * Hand one order that has reached NEW to the fan-out. Called by the Stripe webhook after
 * the flip commits, by `POST /api/orders` for a pay-at-pickup order (and a card order
 * converted by the Stripe-outage failover), and by the synthetic canary for its own
 * one-cent order — the same call, so the canary proves the path customers use.
 *
 * **Idempotent per order, via the event `id`.** Inngest drops an event whose id it
 * has already seen, so the same order cannot start two runs — which is what lets the
 * webhook re-fire a fan-out it could not prove landed (see the re-fire branch in
 * `src/app/api/stripe/webhook/route.ts`) without printing a second ticket. The dedupe
 * window is 24 hours; the print leg checks `print_jobs` as well, so the guarantee
 * outlives it.
 *
 * **Throws on failure, never swallows** — and a send that has not answered within
 * {@link INNGEST_SEND_TIMEOUT_MS} is a failure. The webhook releases its idempotency
 * claim and answers 5xx when this rejects, which is what makes Stripe retry a fan-out
 * that never happened. A silent failure here is an order that is paid, flipped, and
 * that no kitchen ever hears about.
 *
 * Returns the event ids Inngest accepted. The API does **not** say whether an event
 * was deduplicated — a dropped duplicate and a fresh run look identical from here — so
 * the ids are the only handle an operator has: they are what you search the Inngest
 * dashboard with to find out which of the two happened. The re-fire path logs them for
 * exactly that reason.
 */
export async function sendOrderCreated(orderId: string, locationId: string): Promise<string[]> {
  return send({
    name: ORDER_CREATED,
    data: { orderId, locationId } satisfies OrderCreatedData,
    id: `order-created-${orderId}`,
  })
}

/**
 * Why a payment was refused. Both are fail-closed checks in the Stripe webhook, and
 * both are security events rather than data-quality wobbles: a signed event proves
 * Stripe sent it, not whose money it is.
 *
 *   account_mismatch   the money originated on a connected account that is not this
 *                      restaurant's — someone minting an intent with a victim's ids.
 *   amount_mismatch    right account, wrong amount. 50¢ against a $45 order.
 */
export type ProvenanceRefusal = 'account_mismatch' | 'amount_mismatch'

/** Ids and a reason, nothing else — an event payload lives in Inngest's dashboard. */
export type ProvenanceRefusedData = {
  orderId: string
  locationId: string
  reason: ProvenanceRefusal
}

/**
 * Raise the alarm on a payment we refused to act on.
 *
 * The refusals it reports used to be a `console.error` and nothing else, which on a
 * serverless function is a line nobody reads until they are already looking for it —
 * and the whole point of these checks is that they catch something being *attempted*.
 *
 * **Keyed on the Stripe delivery, not the order.** Stripe retries a 5xx for three
 * days and replays from the dashboard on demand, so the same refusal can arrive many
 * times; the dedupe makes that one ring instead of hundreds. Keying on the order
 * instead would hide a second, genuinely different attempt on the same order.
 *
 * Throws like `sendOrderCreated` does. The caller decides what that means; the webhook
 * turns it into a 5xx, so an alert we could not raise is retried rather than lost.
 */
export async function sendProvenanceRefused(
  data: ProvenanceRefusedData,
  stripeEventId: string,
): Promise<string[]> {
  return send({
    name: PROVENANCE_REFUSED,
    data,
    id: `provenance-refused-${stripeEventId}`,
  })
}

/** Ids only, like every event here — an event payload lives in Inngest's dashboard. */
export type StripeOutageData = { orderId: string; locationId: string }

/**
 * Tell the Stripe-outage alarm (`src/inngest/stripe-outage-alert.ts`) that a card order
 * was just converted to pay-at-pickup because Stripe could not be reached.
 *
 * Sent by `POST /api/orders` after the conversion commits, once per converted order and
 * keyed on it — so a retry of the same send is one event, and the alarm's own cooldown
 * turns an evening of conversions into one text an hour. **Best-effort at the caller**:
 * the order is already committed, and a customer's 200 does not depend on our pager.
 */
export async function sendStripeOutage(orderId: string, locationId: string): Promise<string[]> {
  return send({
    name: STRIPE_OUTAGE,
    data: { orderId, locationId } satisfies StripeOutageData,
    id: `stripe-outage-${orderId}`,
  })
}
