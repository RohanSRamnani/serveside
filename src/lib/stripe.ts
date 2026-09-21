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

/** Only the fields the intent is built from — a whole order row satisfies it. */
export type PayableOrder = { id: string; locationId: string; totalCents: number }
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
  }, {
    // THE mechanism. `stripeContext` is the SDK's newer spelling of the same header;
    // swap when it is no longer merely preferred.
    stripeAccount: location.stripeAccountId,
  })

  // A client secret is what the browser needs and the only thing we hand out. Stripe
  // types it nullable (it is absent on a few intent shapes we never create), so the
  // absence is an error here rather than a `null` that surfaces as a blank form.
  if (!intent.client_secret) {
    throw new Error(`Stripe returned PaymentIntent ${intent.id} with no client secret`)
  }
  return { clientSecret: intent.client_secret, paymentIntentId: intent.id }
}
