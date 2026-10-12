import Stripe from 'stripe'
import { env } from '@/lib/env'

/**
 * Stripe, on the one arrangement this product is built around: **Connect Standard
 * with direct charges.**
 *
 * The charge is created *on the connected account* — `{ stripeAccount }` below, which
 * becomes the `Stripe-Account` header. That single option is the entire premise: the
 * restaurant is merchant of record, their name is on the customer's statement, funds
 * settle to their bank, and they carry refund and chargeback liability. Money never
 * touches our balance, so we are not a money transmitter and we are not holding
 * anyone's takings on a Friday night.
 *
 * Never separate charges + transfers, and never destination charges. Both route the
 * money through us and undo all of the above.
 */

let _stripe: Stripe | null = null

/**
 * Lazy on purpose: the key is only read when a request actually needs Stripe, so a
 * pay-at-pickup-only deployment — and every test that mocks this module — never has
 * to hold `STRIPE_SECRET_KEY` at all.
 *
 * `apiVersion` is deliberately not passed. The SDK pins its own, the types only admit
 * that exact literal, and a hardcoded string here would be a second place to forget
 * on upgrade.
 */
export function stripe(): Stripe {
  return (_stripe ??= new Stripe(env('STRIPE_SECRET_KEY'), { typescript: true }))
}

/**
 * The restaurant has not finished Stripe onboarding, so there is no account to charge
 * on. Named rather than a null-deref, because the answer the customer needs is
 * specific: cards are not available here *yet*, and pay-at-pickup still is.
 *
 * Carries a `code` in the same style as the `OrderRejectedError` family, so the HTTP
 * layer maps it without a special case.
 */
export class StripeAccountMissingError extends Error {
  readonly code = 'stripe_account_missing'
  readonly locationId: string

  constructor(locationId: string) {
    super(`Location ${locationId} has no connected Stripe account, so it cannot take card payments`)
    this.name = 'StripeAccountMissingError'
    this.locationId = locationId
  }
}

/**
 * **Is this failure Stripe being down, rather than something about this order?**
 *
 * The one decision the checkout's pay-at-pickup failover hangs off, so it is written
 * once, here, beside the call that throws these. `true` means: the customer did
 * nothing wrong, the restaurant did nothing wrong, and the order should become a
 * pay-at-pickup order rather than be refused.
 *
 * **Three types, and the list is deliberately short.** A connection failure is the
 * SDK never reaching Stripe; an API error is how a Stripe 5xx arrives; a rate limit is
 * their capacity rather than our request. Everything else the SDK can raise says
 * something about *this* call — a bad key, an account we may not act for, a malformed
 * request, a card — and every one of those is ours to fix or the customer's to act on.
 *
 * **The false positives are the expensive direction**, which is why it fails closed on
 * anything it does not recognise. A misconfigured deployment classified as an outage
 * turns every card order on the platform into an unpaid pickup order, and nobody finds
 * out until the till is short. A genuine outage misclassified as our bug costs one
 * order, loudly, on a screen that tells the customer to phone the restaurant.
 *
 * **Classified by `type`, not by `instanceof`**, and that is not a shortcut. Every
 * `StripeError` subclass passes its own class name as `type` (see the SDK's
 * `Error.js`), and `type` is part of its public surface. `instanceof` would be wrong
 * twice over: the route's tests mock the `stripe` module whole, and two copies of the
 * SDK in one process — a bundler, a transitive dependency — produce error objects that
 * fail `instanceof` against the classes we hold while being exactly the same errors.
 * `StripeError` also carries a `code` (`card_declined`), which shares a name with
 * Node's errno and must never be consulted for a Stripe error; hence the two
 * namespaces are separated rather than merged.
 *
 * **Card declines are not here and cannot be.** A decline happens at *confirm* time,
 * in the browser, on the Payment Element — never at intent creation under
 * `automatic_payment_methods`. Task 5's inline retry owns that path and never reaches
 * this function.
 */
export function isStripeOutage(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const { type } = err as { type?: unknown }
  // A Stripe error names itself, and its own name is the whole answer: nothing in the
  // errno namespace below may promote one that this list does not contain.
  if (typeof type === 'string' && type.startsWith('Stripe')) return OUTAGE_STRIPE_TYPES.has(type)
  return isTransportFailure(err, 0)
}

/** The Stripe error types that mean "not us, not them, try later". */
const OUTAGE_STRIPE_TYPES = new Set([
  'StripeConnectionError',
  'StripeAPIError',
  'StripeRateLimitError',
])

/**
 * The transport giving up under the SDK, reported as a plain Node error rather than
 * wrapped in one of Stripe's. `fetch failed` is undici's, and the errnos are what its
 * `cause` carries; the chain is walked because that is where the useful one lives.
 *
 * Bounded depth and an explicit list, for the reason above: an error we cannot name is
 * not an outage. Nothing here matches an ordinary `Error` with a message about Stripe
 * in it, which is exactly the shape a bug in our own code takes.
 */
function isTransportFailure(err: unknown, depth: number): boolean {
  if (depth > 3 || typeof err !== 'object' || err === null) return false
  const e = err as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown }
  if (typeof e.code === 'string' && TRANSPORT_ERROR_CODES.has(e.code)) return true
  if (e.name === 'TypeError' && e.message === 'fetch failed') return true
  return isTransportFailure(e.cause, depth + 1)
}

/** Node/undici errnos for a connection that never opened, or closed under us. */
const TRANSPORT_ERROR_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT',
  'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EPROTO',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT',
])

/**
 * How long **one attempt** to open a PaymentIntent may take: ten seconds, against the
 * SDK's default of eighty.
 *
 * A PaymentIntent is created while a customer watches a spinner, and a healthy Stripe
 * answers in well under a second. The SDK's defaults — 80 seconds an attempt, two
 * retries, and a timeout counts as retryable — add up to about four minutes against a
 * Stripe that never answers. That is longer than anybody waits, and possibly longer
 * than the platform lets the function live: killed first, the route never reaches the
 * catch that converts the order to pay-at-pickup, and the order is stranded at
 * PENDING_PAYMENT with no intent. Bounded here, a hung Stripe surfaces as a
 * `StripeConnectionError` ("Request aborted due to timeout being reached"), which
 * `isStripeOutage` counts, in seconds.
 *
 * Per request, not on the client, so it bounds the one call whose latency a customer
 * sits through and nothing else we may later ask Stripe for.
 */
export const INTENT_TIMEOUT_MS = 10_000

/**
 * One retry, against the SDK's default of two — still enough to ride out the blip the
 * SDK's retry exists for (a stale keep-alive socket on a frozen serverless instance).
 * **Safe to retry at all because the SDK keys every POST**: a retry after an attempt
 * that Stripe actually processed returns that same intent rather than a second one.
 */
export const INTENT_MAX_NETWORK_RETRIES = 1

/** The SDK's own ceiling on one wait between attempts (`MAX_NETWORK_RETRY_DELAY_SEC`). */
const SDK_MAX_RETRY_DELAY_MS = 5_000

/**
 * **The longest `createPaymentIntentFor` can take against a Stripe that never
 * answers**: every attempt runs to its timeout, with the SDK's longest possible wait
 * between them. Deliberately an overestimate — the SDK's first wait is really half a
 * second — because this is what the route's `maxDuration` is checked against, and
 * erring long there costs nothing.
 *
 * `Math.max(…, 1)` because the SDK retries a closed connection (ECONNRESET, EPIPE)
 * once even with retries set to zero, so zero retries is still two attempts.
 *
 * Per attempt, the SDK's timeout is a **socket idle** timer: a Stripe that never
 * answers trips it, but one that trickles a byte every few seconds would not. The
 * route's `maxDuration` is the outer bound for that case.
 */
export const INTENT_WORST_CASE_MS =
  (Math.max(INTENT_MAX_NETWORK_RETRIES, 1) + 1) * INTENT_TIMEOUT_MS
  + Math.max(INTENT_MAX_NETWORK_RETRIES, 1) * SDK_MAX_RETRY_DELAY_MS

/** Only the fields the intent is built from — a whole order row satisfies it. */
export type PayableOrder = { id: string; locationId: string; totalCents: number; contactEmail?: string | null }
export type PayeeLocation = { id: string; stripeAccountId: string | null }

/**
 * Opens a PaymentIntent on the restaurant's own account for exactly what the order
 * totals to.
 *
 * `amount` is `order.totalCents` verbatim. It is not recomputed, re-rounded or
 * converted: the order row already had `subtotal + tax + tip + fee − discount = total`
 * asserted on it immediately before the INSERT, and a second arithmetic path here
 * would be a second way for the charge and the receipt to disagree.
 *
 * `automatic_payment_methods` lets the Payment Element show whatever the restaurant
 * has enabled (cards, wallets, link) without this code enumerating them — and the
 * Payment Element is what keeps card data off our servers entirely (PCI SAQ A).
 *
 * **Both ids go in the metadata, and the location one is not redundant.** The webhook
 * gets nothing but the event: to read the order at all it must open
 * `withLocation(locationId)` first, because RLS hides an unscoped read. Without
 * `locationId` on the intent, the webhook would have to find the order's location
 * from a table it cannot see without already knowing it.
 */
export async function createPaymentIntentFor(
  order: PayableOrder,
  location: PayeeLocation,
): Promise<{ clientSecret: string; paymentIntentId: string }> {
  if (!location.stripeAccountId) throw new StripeAccountMissingError(location.id)

  const intent = await stripe().paymentIntents.create({
    amount: order.totalCents,
    currency: 'usd',
    automatic_payment_methods: { enabled: true },
    metadata: { orderId: order.id, locationId: order.locationId },
    // Stripe's own receipt, sent from the restaurant's account (this is a direct
    // charge). Only when the diner gave an address; omitted, Stripe sends nothing.
    ...(order.contactEmail ? { receipt_email: order.contactEmail } : {}),
  }, {
    // THE mechanism. `stripeContext` is the SDK's newer spelling of the same header;
    // swap when it is no longer merely preferred.
    stripeAccount: location.stripeAccountId,
    // The bound — see `INTENT_TIMEOUT_MS`. Without it, a hung Stripe holds this call
    // for minutes and the failover arrives late or never.
    timeout: INTENT_TIMEOUT_MS,
    maxNetworkRetries: INTENT_MAX_NETWORK_RETRIES,
  })

  // A client secret is what the browser needs and the only thing we hand out. Stripe
  // types it nullable (it is absent on a few intent shapes we never create), so the
  // absence is an error here rather than a `null` that surfaces as a blank form.
  if (!intent.client_secret) {
    throw new Error(`Stripe returned PaymentIntent ${intent.id} with no client secret`)
  }
  return { clientSecret: intent.client_secret, paymentIntentId: intent.id }
}
