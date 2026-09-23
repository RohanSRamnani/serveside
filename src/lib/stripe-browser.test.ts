import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * The browser half of the direct-charge arrangement.
 *
 * `src/lib/stripe.ts` opens the PaymentIntent **on the restaurant's connected
 * account**, so the client secret it hands back is a secret on *that* account and
 * nothing else. A Stripe.js instance built from the platform key alone cannot confirm
 * it — the call goes to the platform account, which has never heard of the intent.
 * The two arguments below are therefore one fact, not two: the **platform**
 * publishable key, plus `{ stripeAccount }` naming whose money this is.
 *
 * Stripe.js is mocked whole. Nothing here loads a script, reaches the network or
 * holds a key: what is under test is how many times we ask for a client and what we
 * ask for.
 *
 * The mocked path is **`@stripe/stripe-js/pure`**, which is the entry the module
 * under test imports — the main entry injects Stripe's script merely on being
 * imported, and mocking the wrong one of the two would quietly be mocking nothing.
 */
const { loadStripe } = vi.hoisted(() => ({ loadStripe: vi.fn(() => Promise.resolve({})) }))
vi.mock('@stripe/stripe-js/pure', () => ({ loadStripe }))

const { stripeBrowser } = await import('./stripe-browser')

/** Obviously not a key. The real one is a build-time env var and never a literal. */
const PUBLISHABLE_KEY = 'pk_test_platform_fake'

beforeEach(() => {
  loadStripe.mockClear()
  process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = PUBLISHABLE_KEY
})

describe('stripeBrowser', () => {
  it('loads Stripe.js with the PLATFORM key and the restaurant as the account', () => {
    // The whole mechanic, asserted rather than described: a connected-account client
    // secret is only confirmable by a Stripe.js instance carrying `stripeAccount`.
    // Loading the key on its own is the bug that looks like "the card just fails".
    stripeBrowser('acct_mechanic')
    expect(loadStripe).toHaveBeenCalledWith(PUBLISHABLE_KEY, { stripeAccount: 'acct_mechanic' })
  })

  it('loads it ONCE per connected account, however often a render asks', () => {
    // `loadStripe` injects a script tag and resolves a singleton; called on every
    // render it re-enters that work and — worse — hands `<Elements>` a new promise
    // each time, which remounts the Payment Element and throws away whatever the
    // customer has typed into it.
    const first = stripeBrowser('acct_memo')
    const second = stripeBrowser('acct_memo')

    expect(loadStripe).toHaveBeenCalledTimes(1)
    expect(second).toBe(first)
  })

  it('gives a second restaurant its own client, never the first one reused', () => {
    // One origin serves every storefront, so two restaurants' checkouts can live in
    // one tab's history. A client memoized without the account id would confirm the
    // second restaurant's payment against the first one's account.
    const kashi = stripeBrowser('acct_kashi')
    const other = stripeBrowser('acct_other')

    expect(loadStripe).toHaveBeenCalledTimes(2)
    expect(other).not.toBe(kashi)
    expect(loadStripe).toHaveBeenLastCalledWith(PUBLISHABLE_KEY, { stripeAccount: 'acct_other' })
  })

  it('is null — and loads nothing — when there is no publishable key', () => {
    // Blank-safe rather than truthy-safe: an unset Vercel variable arrives as `''`.
    // `loadStripe('')` rejects asynchronously, which would surface as a dead Payment
    // Element on the one screen that must not break, so the absence is answered here.
    for (const key of ['', '   ']) {
      process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = key
      expect(stripeBrowser('acct_keyless'), JSON.stringify(key)).toBeNull()
    }
    delete process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
    expect(stripeBrowser('acct_keyless')).toBeNull()
    expect(loadStripe).not.toHaveBeenCalled()
  })

  it('is null for a restaurant that has not finished Stripe onboarding', () => {
    // `locations.stripe_account_id` is nullable and null is the normal state of a
    // restaurant we have just signed. There is no account to charge on, so there is
    // no client to build — the same fact the server states as
    // `StripeAccountMissingError`, on the side of the wire that has to render.
    expect(stripeBrowser(null)).toBeNull()
    expect(stripeBrowser('')).toBeNull()
    expect(stripeBrowser('   ')).toBeNull()
    expect(loadStripe).not.toHaveBeenCalled()
  })
})
