import { describe, it, expect, vi, afterEach } from 'vitest'
import Stripe from 'stripe'
import { createPaymentIntentFor, isStripeOutage, stripe, StripeAccountMissingError } from './stripe'

/**
 * **What counts as Stripe being down**, which is the whole of the decision the
 * checkout failover hangs off — so it is tested against the SDK's *real* error
 * objects, never a hand-rolled `{ type: '...' }` stand-in. The route's own tests
 * mock the `stripe` module whole; this file deliberately does not, because the thing
 * under test is exactly the shape the SDK constructs.
 *
 * The line is drawn by **whose fault it is**, not by how bad it looks:
 *
 * - **An outage** is a failure to open a PaymentIntent that is Stripe's or the
 *   network's: the customer did nothing wrong, the restaurant did nothing wrong, and
 *   the order should become a pay-at-pickup order rather than be refused.
 * - **Not an outage** is anything that says something about *this* request — bad
 *   credentials, a permission we do not have, a malformed call, a card. Those are
 *   ours to fix or the customer's to act on, and converting them to pay-at-pickup
 *   would silently sell food on the back of our own bug.
 *
 * The false positives are the expensive direction: a misconfigured deployment
 * classified as an outage turns every card order in the country into an unpaid
 * pickup order, and nobody finds out until the till is short.
 */

/** The SDK's raw-error shape, as the transport hands it to the generator. */
function raw(over: Record<string, unknown> = {}) {
  return { message: 'stripe said so', ...over }
}

describe('isStripeOutage — Stripe is down', () => {
  it('counts a connection failure: the SDK could not reach Stripe at all', () => {
    expect(isStripeOutage(new Stripe.errors.StripeConnectionError(raw()))).toBe(true)
  })

  it('counts an API error, which is how a Stripe 5xx arrives', () => {
    expect(isStripeOutage(new Stripe.errors.StripeAPIError(raw({ statusCode: 503 })))).toBe(true)
  })

  it('counts a rate limit: their capacity, not our request', () => {
    expect(isStripeOutage(new Stripe.errors.StripeRateLimitError(raw({ statusCode: 429 })))).toBe(true)
  })

  it('counts a bare transport failure thrown through the SDK', () => {
    // undici's shape when a fetch never completes, and the errno shapes underneath it.
    expect(isStripeOutage(new TypeError('fetch failed'))).toBe(true)
    expect(isStripeOutage(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))).toBe(true)
    expect(isStripeOutage(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }))).toBe(true)
    // Wrapped, which is how Node reports the cause of a failed fetch.
    expect(isStripeOutage(Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    }))).toBe(true)
  })
})

describe('isStripeOutage — not an outage', () => {
  it('does not count a card error', () => {
    // A decline cannot happen at intent creation under `automatic_payment_methods`,
    // and if one ever surfaced here it would still be about a card rather than about
    // Stripe. Confirm-time declines are the Payment Element's inline retry and never
    // reach this function at all.
    expect(isStripeOutage(new Stripe.errors.StripeCardError(raw({
      code: 'card_declined', decline_code: 'generic_decline',
    })))).toBe(false)
  })

  it('does not count our own misconfiguration or our own bug', () => {
    // Every one of these says something about *this request*: a wrong key, an account
    // we may not act for, a call we built wrong. Failing these over would hide a
    // deployment fault behind a nationwide flip to unpaid pickup orders.
    expect(isStripeOutage(new Stripe.errors.StripeAuthenticationError(raw()))).toBe(false)
    expect(isStripeOutage(new Stripe.errors.StripePermissionError(raw()))).toBe(false)
    expect(isStripeOutage(new Stripe.errors.StripeInvalidRequestError(raw()))).toBe(false)
  })

  it('does not count a restaurant that never onboarded — that is still a 503', () => {
    // `StripeAccountMissingError` is ours, not the SDK's: the restaurant has no
    // connected account, so there is nothing down and nothing to fail over to. The
    // customer is told cards are not set up here, which is the truth.
    expect(isStripeOutage(new StripeAccountMissingError('loc-1'))).toBe(false)
  })

  it('does not count an unrecognised error, or a non-error', () => {
    // The default has to be "not an outage": an unknown failure converted to
    // pay-at-pickup is food leaving the kitchen on the strength of a bug we have not
    // read yet. This is also the exact shape the existing leak test throws.
    expect(isStripeOutage(new Error('stripe card_declined internals: acct_secret'))).toBe(false)
    expect(isStripeOutage(new TypeError('x.y is not a function'))).toBe(false)
    expect(isStripeOutage('ECONNRESET')).toBe(false)
    expect(isStripeOutage(null)).toBe(false)
    expect(isStripeOutage(undefined)).toBe(false)
    expect(isStripeOutage({})).toBe(false)
  })

  it('does not count a Stripe error type it has never heard of', () => {
    // Fails closed by name, not by absence: a new `StripeSomethingError` is not an
    // outage until somebody decides it is one, here, on purpose.
    expect(isStripeOutage(new Stripe.errors.StripeIdempotencyError(raw()))).toBe(false)
    expect(isStripeOutage(new Stripe.errors.StripeSignatureVerificationError('h', 'p', raw()))).toBe(false)
  })

  it('is not fooled by a Stripe error whose own `code` reads like an errno', () => {
    // `StripeError.code` is Stripe's error code (`card_declined`), and it shares a
    // field name with Node's errno. A Stripe error is classified by its `type` alone,
    // so nothing in that second namespace can promote one to an outage.
    expect(isStripeOutage(new Stripe.errors.StripeInvalidRequestError(raw({
      code: 'ECONNRESET',
    })))).toBe(false)
  })
})

describe('createPaymentIntentFor — the receipt', () => {
  afterEach(() => vi.restoreAllMocks())

  /** The real client, with only the network call replaced, so the params are the ones sent. */
  function spyCreate() {
    return vi.spyOn(stripe().paymentIntents, 'create')
      .mockResolvedValue({ id: 'pi_1', client_secret: 'pi_1_secret' } as never)
  }
  const location = { id: 'loc-1', stripeAccountId: 'acct_1' }
  const order = { id: 'ord-1', locationId: 'loc-1', totalCents: 4524 }

  it('asks Stripe for a receipt to the diner\'s address when there is one', async () => {
    const create = spyCreate()
    await createPaymentIntentFor({ ...order, contactEmail: 'diner@example.com' }, location)
    expect(create.mock.calls[0][0]).toMatchObject({ receipt_email: 'diner@example.com' })
  })

  it('sends no receipt_email at all when the diner gave none', async () => {
    const create = spyCreate()
    await createPaymentIntentFor({ ...order, contactEmail: null }, location)
    await createPaymentIntentFor(order, location)
    for (const [params] of create.mock.calls) expect(params).not.toHaveProperty('receipt_email')
  })
})
