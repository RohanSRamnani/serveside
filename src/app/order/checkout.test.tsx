import { describe, it, expect, vi } from 'vitest'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CartLine } from './[location]/cart-provider'
import type { StorefrontLocation } from '@/domain/storefront'
import { MAX_TIP_CENTS } from '@/lib/order-limits'

/**
 * The last screen between a hungry person and their dinner, and the one place this
 * product collects anything it can be held to: a phone number, a tip, an SMS
 * marketing opt-in with legal weight — and, since Task 5, a card.
 *
 * Split the way `browse.test.tsx` is split, for the same reason — there is no jsdom
 * in this suite, so every decision worth making is an ordinary function and is tested
 * as one, while everything that has to *appear* is rendered to static markup from a
 * fully-controlled view. What is deliberately **not** covered here is the network: the
 * POST, its four failure branches and the navigation afterwards need a browser, and
 * the order route's own DB-backed tests are what prove the body this file builds is
 * one the server accepts.
 *
 * **Stripe is mocked at both seams**, and neither mock is incidental:
 *
 * - `@stripe/react-stripe-js` — `<Elements>` is a context provider and `useStripe` /
 *   `useElements` read that context, so the real ones cannot be rendered to a string.
 *   The stand-in renders its children and publishes the `clientSecret` it was handed
 *   as an attribute, which is the one thing about it worth asserting.
 * - `@/lib/stripe-browser` — so a render never reaches `loadStripe`, and so the
 *   "there is no Stripe here" branch can be driven on demand.
 */

const { stripeBrowser } = vi.hoisted(() => ({
  stripeBrowser: vi.fn((): unknown => Promise.resolve({})),
}))
vi.mock('@/lib/stripe-browser', () => ({ stripeBrowser }))

const { useStripe, useElements } = vi.hoisted(() => ({
  useStripe: vi.fn((): unknown => ({})),
  useElements: vi.fn((): unknown => ({})),
}))
vi.mock('@stripe/react-stripe-js', () => ({
  Elements: ({ children, options }: { children: ReactNode; options: { clientSecret?: string } }) => (
    <div data-elements="1" data-client-secret={options.clientSecret}>{children}</div>
  ),
  PaymentElement: () => <div data-payment-element="1" />,
  useStripe,
  useElements,
}))

import {
  CheckoutFormView, NETWORK_FAILURE_MESSAGE, PaymentPaneView, PaymentStep, TIP_PERCENTS,
  UNREADABLE_SUCCESS_MESSAGE, cardPaymentAvailable, checkoutHref, confirmArgsFor,
  confirmOutcome, consentDisclosure, customTipCents, normalizePhone, orderBodyFrom,
  quoteLabel, returnUrlFor, statusHref, submitFailureMessage, tipCentsFor, tipPresetCents,
  type CheckoutFormState,
} from './[location]/checkout/checkout-form'

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const KASHI: StorefrontLocation = {
  name: 'Kashi',
  slug: 'kashi',
  timezone: 'America/New_York',
  phoneE164: '+19735550123',
  address: '123 Livingston Ave, Livingston NJ',
  prepTimeMinutes: 20,
  taxRatePer100k: 8875,
  // Whose account the charge is created on. It travels to the browser because every
  // Stripe.js call the browser makes carries it — see `StorefrontLocation`.
  stripeAccountId: 'acct_test_kashi',
}

/** A fake secret in the shape Stripe hands back. Never a real one, in any run. */
const CLIENT_SECRET = 'pi_test_123_secret_abc'

/** 1800 + 50 = 1850 a unit, two of them: a 3700 subtotal, the same one the API tests use. */
const LINES: CartLine[] = [{
  menuItemId: 'itm-butter-chicken',
  name: 'Butter Chicken',
  unitPriceCents: 1850,
  qty: 2,
  modifierOptionIds: ['opt-hot'],
  modifierNames: ['Hot'],
  modifierDeltaCents: 50,
  notes: 'no cilantro',
}]

function form(over: Partial<CheckoutFormState> = {}): CheckoutFormState {
  return {
    name: 'Rohan R',
    phone: '(555) 123-4567',
    email: '',
    tipPercent: 15,
    customTip: '',
    consent: false,
    payment: 'pay_on_pickup',
    ...over,
  }
}

type ViewOver = Partial<Parameters<typeof CheckoutFormView>[0]>

function render(over: ViewOver = {}): string {
  return renderToStaticMarkup(
    <CheckoutFormView
      location={KASHI}
      lines={LINES}
      hydrated
      closedReason={null}
      cardAvailable={false}
      quote="Ready around 7:35 PM"
      form={form()}
      busy={false}
      error={null}
      onChange={() => {}}
      onSubmit={() => {}}
      {...over}
    />,
  )
}

// ---------------------------------------------------------------------------
// The phone number.
// ---------------------------------------------------------------------------

describe('normalizePhone', () => {
  it('turns what a US customer actually types into E.164', () => {
    // Nobody types `+15551234567` into a form. They type the number off a phone
    // screen, with whatever punctuation their muscle memory supplies — and the server
    // refuses anything that is not E.164, so an un-normalised form is a checkout that
    // fails at the last step for a reason no customer can act on.
    for (const typed of [
      '5551234567', '(555) 123-4567', '555-123-4567', '555.123.4567', '555 123 4567',
      '15551234567', '1 (555) 123-4567', '+1 555 123 4567', '+15551234567',
    ]) {
      expect(normalizePhone(typed), typed).toBe('+15551234567')
    }
  })

  it('refuses anything it cannot turn into a US number, rather than guessing', () => {
    // `null` is a form error the customer is shown, never a value that is posted. A
    // "best effort" here is a wrong number on a ticket, and the wrong number on a
    // ticket is a cold dinner nobody can be called about.
    for (const typed of [
      '', '   ', '555', '55512345', '5551234567890123', 'five five five',
      '+44 20 7123 4567', '(555) 123-456', 'call me',
    ]) {
      expect(normalizePhone(typed), JSON.stringify(typed)).toBeNull()
    }
  })
})

// ---------------------------------------------------------------------------
// The tip. Integer cents, always — the whole file's reason for existing.
// ---------------------------------------------------------------------------

describe('tipPresetCents', () => {
  it('is a percentage of the SUBTOTAL, not of the taxed total', () => {
    // Tipping on tax is tipping the state. Every register in the country tips on the
    // pre-tax subtotal, and a customer who works it out and finds we did otherwise is
    // right to be annoyed.
    expect(tipPresetCents(3700, 0)).toBe(0)
    expect(tipPresetCents(3700, 10)).toBe(370)
    expect(tipPresetCents(3700, 15)).toBe(555)
    expect(tipPresetCents(3700, 20)).toBe(740)
  })

  it('rounds half UP, the way money.ts does and banker’s rounding does not', () => {
    // 1845 × 10% = 184.5. Half-up says 185; round-half-to-even says 184, because 184
    // is even. The same ruling `taxCentsFor` is written around: one rounding, on one
    // receipt, that a diner compares against a card statement.
    expect(tipPresetCents(1845, 10)).toBe(185)
    expect(tipPresetCents(1855, 10)).toBe(186)
    // 1850 × 15% = 277.5 → 278.
    expect(tipPresetCents(1850, 15)).toBe(278)
  })

  it('offers the four presets the brief names, starting at none', () => {
    // Zero is first and is a real option, not an absence of one. A tip screen with no
    // way to decline is the incumbents' dark pattern, and it is the thing an owner
    // gets complained to about.
    expect([...TIP_PERCENTS]).toEqual([0, 10, 15, 20])
  })
})

describe('customTipCents', () => {
  it('reads whole cents out of a dollars field without ever making a float', () => {
    // `parseFloat('3.35') * 100` is 334.99999999999994. This is the one place a
    // customer types money, so it is the one place that arithmetic must not happen.
    expect(customTipCents('3')).toBe(300)
    expect(customTipCents('3.5')).toBe(350)
    expect(customTipCents('3.50')).toBe(350)
    expect(customTipCents('3.35')).toBe(335)
    expect(customTipCents('0.07')).toBe(7)
    expect(customTipCents('.5')).toBe(50)
    expect(customTipCents('12.00')).toBe(1200)
    expect(customTipCents('0')).toBe(0)
    // An empty custom field is "no tip", not an error: it is what the box looks like
    // the moment a customer taps Custom.
    expect(customTipCents('')).toBe(0)
    expect(customTipCents('  ')).toBe(0)
  })

  it('refuses anything that is not a plain dollar amount', () => {
    for (const typed of ['3.456', 'abc', '-1', '1e3', '3,50', '$3', '3.5.0', '  3 5 ']) {
      expect(customTipCents(typed), JSON.stringify(typed)).toBeNull()
    }
  })

  it('takes a tip up to the shared cap and refuses one cent more', () => {
    // The same `MAX_TIP_CENTS` the server enforces, imported rather than restated —
    // a client looser than the server wastes a customer's time at the last step, and
    // a client tighter than it refuses a tip nobody can explain. `order-limits.ts`
    // has no imports of its own precisely so the browser can read this number.
    expect(customTipCents('2000')).toBe(MAX_TIP_CENTS)
    expect(customTipCents('2000.00')).toBe(MAX_TIP_CENTS)
    expect(customTipCents('1999.99')).toBe(MAX_TIP_CENTS - 1)
    expect(customTipCents('2000.01')).toBeNull()
    expect(customTipCents('9999999.99')).toBeNull()
  })

  it('keeps the cap the server’s number, not a copy of it', () => {
    // If someone retunes `MAX_TIP_CENTS`, this still holds; a hardcoded 200000 here
    // would pass while the two sides quietly disagreed.
    const atCap = (MAX_TIP_CENTS / 100).toFixed(2)
    expect(customTipCents(atCap)).toBe(MAX_TIP_CENTS)
    expect(customTipCents(((MAX_TIP_CENTS + 1) / 100).toFixed(2))).toBeNull()
  })
})

describe('tipCentsFor', () => {
  it('takes the preset when one is chosen and the typed amount otherwise', () => {
    expect(tipCentsFor(form({ tipPercent: 20 }), 3700)).toBe(740)
    expect(tipCentsFor(form({ tipPercent: null, customTip: '4.25' }), 3700)).toBe(425)
  })

  it('is null — a form error, never a silent zero — when the custom amount is junk', () => {
    // A silent fallback to 0 here is a customer who meant to tip $5 and did not, and
    // a server who was never told. The submit is blocked instead.
    expect(tipCentsFor(form({ tipPercent: null, customTip: 'ten bucks' }), 3700)).toBeNull()
    // Over the cap is the same kind of answer: blocked, never clamped. Clamping would
    // charge a number the customer did not type.
    expect(tipCentsFor(form({ tipPercent: null, customTip: '50000' }), 3700)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The pickup quote, in the restaurant's clock.
// ---------------------------------------------------------------------------

describe('quoteLabel', () => {
  it('renders the ready time in the LOCATION’s timezone, never the phone’s', () => {
    // The `renderTicket` rule, now binding on the web: a customer is told the
    // restaurant's wall clock. A diner in London ordering ahead in Brooklyn must read
    // the time the kitchen will read, or they arrive five hours early.
    const at = new Date('2026-09-22T23:15:00Z')
    expect(quoteLabel(at, 20, 'America/New_York')).toBe('Ready around 7:35 PM')
    expect(quoteLabel(at, 20, 'America/Los_Angeles')).toBe('Ready around 4:35 PM')
    expect(quoteLabel(at, 20, 'UTC')).toBe('Ready around 11:35 PM')
  })

  it('carries the prep time across an hour and a midnight without arithmetic of its own', () => {
    expect(quoteLabel(new Date('2026-09-23T03:50:00Z'), 20, 'UTC')).toBe('Ready around 4:10 AM')
    // 23:55 UTC + 20 = 00:15 the next day. `12:15 AM`, not `0:15` and not `24:15`.
    expect(quoteLabel(new Date('2026-09-22T23:55:00Z'), 20, 'UTC')).toBe('Ready around 12:15 AM')
  })
})

// ---------------------------------------------------------------------------
// Consent. The wording is the legal artefact, so it is pinned verbatim.
// ---------------------------------------------------------------------------

describe('consentDisclosure', () => {
  it('is the required sentence, with the restaurant’s own name in it', () => {
    expect(consentDisclosure('Kashi')).toBe(
      'Yes, text me offers and updates from Kashi. '
      + 'Msg & data rates may apply. Reply STOP to opt out.',
    )
  })
})

// ---------------------------------------------------------------------------
// The body that is POSTed.
// ---------------------------------------------------------------------------

describe('orderBodyFrom', () => {
  it('maps the cart straight onto CreateOrderInput', () => {
    const body = orderBodyFrom({
      locationId: 'loc-1', lines: LINES, form: form({ consent: true }),
      phoneE164: '+15551234567', tipCents: 555,
    })
    expect(body).toEqual({
      locationId: 'loc-1',
      channel: 'web',
      // Pickup only, and stated rather than inferred: there is no delivery UI to
      // produce any other value, and this is the field that would have to change.
      fulfillment: 'pickup',
      contact: { name: 'Rohan R', phone: '+15551234567' },
      items: [{
        menuItemId: 'itm-butter-chicken',
        qty: 2,
        modifierOptionIds: ['opt-hot'],
        notes: 'no cilantro',
      }],
      tipCents: 555,
      payment: 'pay_on_pickup',
      smsMarketingConsent: true,
    })
  })

  it('omits an email that was never typed, and trims the name', () => {
    // `contact.email` is optional in the contract and a nullable column underneath.
    // Posting `''` would write an empty string where the absence of an address is the
    // truth, and "did not give one" and "gave a blank one" must not become one row.
    const body = orderBodyFrom({
      locationId: 'loc-1', lines: LINES, form: form({ name: '  Rohan R  ', email: '   ' }),
      phoneE164: '+15551234567', tipCents: 0,
    })
    expect(body.contact).toEqual({ name: 'Rohan R', phone: '+15551234567' })
    expect(body.contact).not.toHaveProperty('email')

    const withEmail = orderBodyFrom({
      locationId: 'loc-1', lines: LINES, form: form({ email: '  rohan@example.com ' }),
      phoneE164: '+15551234567', tipCents: 0,
    })
    expect(withEmail.contact.email).toBe('rohan@example.com')
  })

  it('never sends a line note that is only whitespace', () => {
    const body = orderBodyFrom({
      locationId: 'loc-1',
      lines: [{ ...LINES[0], notes: '   ' }],
      form: form(), phoneE164: '+15551234567', tipCents: 0,
    })
    expect(body.items[0]).not.toHaveProperty('notes')
  })
})

// ---------------------------------------------------------------------------
// Where the two links go.
// ---------------------------------------------------------------------------

describe('the routes either side of this page', () => {
  it('builds them from the public slug, which is the only slug a link may use', () => {
    expect(checkoutHref('kashi')).toBe('/order/kashi/checkout')
    expect(statusHref('kashi', 'ord-123')).toBe('/order/kashi/status/ord-123')
  })
})

// ---------------------------------------------------------------------------
// What the customer is told when the POST did not produce an order.
// ---------------------------------------------------------------------------

describe('submitFailureMessage', () => {
  it('passes a 422 through verbatim — the route wrote it for the customer', () => {
    // "Butter Chicken is sold out" is something they can act on, and it is already in
    // their words. Replacing it with a generic sentence throws away the only useful
    // thing in the response.
    expect(submitFailureMessage(422, { error: 'item_unavailable', message: 'Butter Chicken is sold out' }))
      .toBe('Butter Chicken is sold out')
  })

  it('still says something useful when a 422 arrives with no message', () => {
    // A proxy can produce a 422 we did not write. `error` is a code, not a sentence,
    // so it must never be what a customer reads.
    for (const body of [{}, { error: 'invalid_input' }, { message: '' }]) {
      const said = submitFailureMessage(422, body)
      expect(said, JSON.stringify(body)).toMatch(/can’t be placed/i)
      expect(said).not.toMatch(/invalid_input/)
    }
  })

  it('names the way out of a 503, which is on this very screen', () => {
    // `stripe_account_missing` — the restaurant has not finished onboarding. Not the
    // customer's fault, not permanent, and there is a Pay at pickup radio right there.
    expect(submitFailureMessage(503, { error: 'stripe_account_missing' }))
      .toMatch(/pay at pickup/i)
  })

  it('says plainly that nothing was ordered when the failure is ours', () => {
    // The one thing a customer must not be left unsure about. Unsure, they either
    // give up or order a second dinner.
    for (const status of [500, 502, 400, 418]) {
      expect(submitFailureMessage(status, {}), String(status)).toMatch(/nothing was ordered/i)
    }
    expect(NETWORK_FAILURE_MESSAGE).toMatch(/couldn’t reach|try again/i)
  })

  it('never promises that nothing happened after a 200 — that one sends them to the phone', () => {
    // A 200 with a body we cannot read means the order WAS written. Telling somebody
    // nothing was ordered there is how they end up with two dinners and two charges,
    // so it is a separate message and it does not invite a retry.
    expect(UNREADABLE_SUCCESS_MESSAGE).toMatch(/may have gone through/i)
    expect(UNREADABLE_SUCCESS_MESSAGE).toMatch(/call the restaurant/i)
    expect(UNREADABLE_SUCCESS_MESSAGE).not.toMatch(/nothing was ordered|try again/i)
  })

  it('never leaks a code or an internal detail into what a customer reads', () => {
    const leaky = { error: 'server_error', message: 'relation "orders" does not exist', detail: 'acct_secret' }
    const said = submitFailureMessage(500, leaky)
    expect(said).not.toMatch(/relation|orders|acct_secret|server_error/)
  })
})

// ---------------------------------------------------------------------------
// Which payment modes exist at all.
// ---------------------------------------------------------------------------

describe('cardPaymentAvailable', () => {
  it('needs BOTH halves of the direct charge, and there are four ways to ask', () => {
    // The two are one fact, not two. The platform's publishable key says *we* can
    // talk to Stripe; the connected account id says *whose money* this is — and a
    // client secret minted on the restaurant's account cannot be confirmed without
    // it. Either one missing is a restaurant that takes cash at the counter today.
    expect(cardPaymentAvailable('pk_test_abc123', 'acct_123')).toBe(true)
    expect(cardPaymentAvailable('pk_test_abc123', null)).toBe(false)
    expect(cardPaymentAvailable(undefined, 'acct_123')).toBe(false)
    expect(cardPaymentAvailable(undefined, null)).toBe(false)
  })

  it('is false for every shape of a key that is not set', () => {
    // Blank-safe rather than truthy-safe: an unset Vercel env var arrives as `''`,
    // not as undefined, and a Payment Element mounted with a blank key throws at
    // runtime on the one screen that must not break.
    expect(cardPaymentAvailable(undefined, 'acct_123')).toBe(false)
    expect(cardPaymentAvailable('', 'acct_123')).toBe(false)
    expect(cardPaymentAvailable('   ', 'acct_123')).toBe(false)
  })

  it('is false for a restaurant that has not finished onboarding, key or no key', () => {
    // `locations.stripe_account_id` is null on every restaurant we have just signed,
    // and the server already refuses that order by name (`stripe_account_missing`,
    // 503). Hiding the radio is the same ruling one screen earlier: a customer should
    // not be able to choose a payment method that cannot work.
    for (const account of [null, '', '   ']) {
      expect(cardPaymentAvailable('pk_test_abc123', account), JSON.stringify(account)).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// What happens after `stripe.confirmPayment` comes back.
// ---------------------------------------------------------------------------

describe('confirmOutcome', () => {
  it('sends a succeeded payment to the status page and empties the cart', () => {
    // The cart's whole purpose is served the moment Stripe has the money — and a
    // customer returning to the menu must not find the dishes they have just paid
    // for still sitting in it.
    expect(confirmOutcome({ paymentIntent: { status: 'succeeded' } }))
      .toEqual({ kind: 'paid', clearCart: true })
  })

  it('treats `processing` as done too — the webhook is what marks an order paid', () => {
    // Nothing is EVER marked paid in a browser. `processing` is a payment Stripe has
    // accepted and not yet settled (an ACH debit, a delayed method); the order stays
    // PENDING_PAYMENT until `payment_intent.succeeded` arrives at the webhook, and
    // Task 6's status page says "confirming payment…" in the meantime. Keeping the
    // customer on the checkout instead would be asking them to pay twice.
    expect(confirmOutcome({ paymentIntent: { status: 'processing' } }))
      .toEqual({ kind: 'paid', clearCart: true })
  })

  it('shows Stripe’s own words on a decline, and keeps the cart', () => {
    // Stripe's message is written for the cardholder ("Your card was declined") and
    // is the only thing on the screen they can act on. Ours would be a worse copy of
    // it — and the cart has to survive, because the next thing they do is try another
    // card on this very screen, against this very PaymentIntent.
    expect(confirmOutcome({ error: { message: 'Your card was declined.' } }))
      .toEqual({ kind: 'failed', clearCart: false, message: 'Your card was declined.' })
  })

  it('still says something when Stripe hands back an error with no message', () => {
    // `StripeError.message` is optional in the type and absent for some network
    // failures. A blank error box is a customer who cannot tell whether they paid.
    for (const error of [{}, { message: '' }]) {
      const outcome = confirmOutcome({ error })
      expect(outcome.kind, JSON.stringify(error)).toBe('failed')
      expect(outcome.kind === 'failed' && outcome.message).toMatch(/\w/)
    }
  })

  it('never clears the cart for an intent that is not a payment yet', () => {
    // `requires_payment_method` is what an intent falls back to after a failed
    // confirm; `requires_action` is one that needs a step we did not complete. No
    // money has moved in either, so this is a retry on the same intent — and a
    // cleared cart there is a customer with nothing to retry with.
    for (const status of ['requires_payment_method', 'requires_action', 'requires_confirmation', 'canceled']) {
      const outcome = confirmOutcome({ paymentIntent: { status } })
      expect(outcome.kind, status).toBe('failed')
      expect(outcome.clearCart, status).toBe(false)
    }
  })

  it('does not call a payment done on a result with neither an intent nor an error', () => {
    // Unreachable by the SDK's own types, and the one wrong answer here is expensive:
    // routing away and clearing the cart on a payment that may never have happened.
    const outcome = confirmOutcome({})
    expect(outcome.kind).toBe('failed')
    expect(outcome.clearCart).toBe(false)
  })
})

describe('returnUrlFor', () => {
  it('is the status page, absolute, because Stripe refuses a relative return_url', () => {
    // A redirect-based method leaves our origin entirely and comes back by URL, so
    // there is no page to be relative to. Built from `statusHref`, never restated:
    // Task 6 owns that page and the two ends must not be able to disagree.
    expect(returnUrlFor('https://order.kashi.com', 'kashi', 'ord-123'))
      .toBe(`https://order.kashi.com${statusHref('kashi', 'ord-123')}`)
    expect(returnUrlFor('http://localhost:3007', 'kashi', 'ord-123'))
      .toBe('http://localhost:3007/order/kashi/status/ord-123')
  })
})

// ---------------------------------------------------------------------------
// What `stripe.confirmPayment` is actually CALLED with.
// ---------------------------------------------------------------------------

describe('confirmArgsFor', () => {
  /** Stripe's Elements group is an opaque handle here; only its identity matters. */
  const elements = { theGroup: true } as unknown as Parameters<typeof confirmArgsFor>[0]

  it('is the whole argument, so the call itself is what gets reviewed', () => {
    // The result object, entire. `confirmOutcome` pins what comes back from Stripe;
    // this pins what goes in — the half that used to live inline in a handler no
    // test could reach, where deleting the `return_url` broke nothing.
    expect(confirmArgsFor(elements, 'https://order.kashi.com', 'kashi', 'ord-123')).toEqual({
      elements,
      redirect: 'if_required',
      confirmParams: { return_url: 'https://order.kashi.com/order/kashi/status/ord-123' },
    })
  })

  it('confirms in place — `if_required`, never `always`', () => {
    // **The one mistake TypeScript cannot catch.** Both literals satisfy an overload,
    // and `'always'` navigates EVERY card customer off to Stripe mid-checkout and
    // back, turning an in-place confirm into a full round trip. Pinned by value for
    // exactly that reason.
    expect(confirmArgsFor(elements, 'https://order.kashi.com', 'kashi', 'ord-1').redirect)
      .toBe('if_required')
  })

  it('hands Stripe the same absolute status URL `returnUrlFor` builds', () => {
    // The wiring, not just the value: a `return_url` that is dropped, hardcoded or
    // built a second way is a redirect-based payment that comes back to the wrong
    // page — or, relative, one Stripe refuses outright.
    const origin = 'http://localhost:3007'
    const { confirmParams } = confirmArgsFor(elements, origin, 'kashi', 'ord-9')
    expect(confirmParams.return_url).toBe(returnUrlFor(origin, 'kashi', 'ord-9'))
    expect(confirmParams.return_url.startsWith(`${origin}/`)).toBe(true)
  })

  it('carries THIS Elements group, which is what holds the customer’s card', () => {
    // Passed through by identity. A fresh or wrong group confirms an intent against
    // fields the customer never typed into.
    expect(confirmArgsFor(elements, 'https://x.test', 'kashi', 'ord-1').elements).toBe(elements)
  })
})

// ---------------------------------------------------------------------------
// The markup.
// ---------------------------------------------------------------------------

describe('CheckoutFormView', () => {
  it('leaves the SMS consent box UNCHECKED, in a block of its own', () => {
    // The whole legal point. An opt-in that arrives pre-ticked is not consent, and a
    // marketing opt-in bundled into "place my order" is not consent either — so the
    // checkbox is separate from the submit and starts empty. React omits the
    // attribute entirely for `checked={false}`, so its presence anywhere on this
    // input is the bug.
    const markup = render()
    const input = markup.match(/<input[^>]*data-consent="1"[^>]*>/)
    expect(input, 'no consent checkbox in the markup').not.toBeNull()
    expect(input![0]).toContain('type="checkbox"')
    expect(input![0]).not.toContain('checked')
  })

  it('prints the disclosure verbatim, with the restaurant’s name', () => {
    const markup = render()
    expect(markup).toContain('Yes, text me offers and updates from Kashi.')
    expect(markup).toContain('Msg &amp; data rates may apply. Reply STOP to opt out.')
  })

  it('says the marketing opt-in is optional, so it cannot read as a condition of ordering', () => {
    expect(render()).toMatch(/optional/i)
  })

  it('shows the pickup quote in words, and offers no other pickup time', () => {
    const markup = render()
    expect(markup).toContain('Ready around 7:35 PM')
    // ASAP only in this plan. A scheduling control that does nothing is worse than
    // none, and `orders.scheduled_for` stays null until there is a product for it.
    expect(markup).not.toMatch(/schedule|later today|pick a time/i)
  })

  it('offers pickup and nothing else — no delivery, not even hidden', () => {
    // The plan's constraint, asserted rather than assumed: a delivery control that
    // exists but is hidden is one CSS change away from taking an order this product
    // cannot fulfil.
    expect(render()).not.toMatch(/deliver/i)
  })

  it('hides the card option entirely when there is no publishable key', () => {
    const markup = render({ cardAvailable: false })
    expect(markup).not.toMatch(/data-payment="card"/)
    expect(markup).toMatch(/data-payment="pay_on_pickup"/)
  })

  it('offers both modes when Stripe is configured', () => {
    const markup = render({ cardAvailable: true })
    expect(markup).toMatch(/data-payment="card"/)
    expect(markup).toMatch(/data-payment="pay_on_pickup"/)
  })

  it('shows the money it is about to ask for, tip included', () => {
    // The drawer's total is pre-tip and says so. This is the first screen that can
    // show the real number, and it must, because it is the number being authorised.
    const markup = render()
    expect(markup).toContain('$37.00')  // subtotal
    expect(markup).toContain('$3.28')   // tax, 3700 × 8875/100k = 328.375 → 328
    expect(markup).toContain('$5.55')   // 15% of 3700
    expect(markup).toContain('$45.83')  // 3700 + 328 + 555
  })

  it('still calls the total an estimate — the server is what computes the charge', () => {
    expect(render()).toMatch(/estimate/i)
  })

  it('disables the submit while a request is in flight, so nobody double-posts', () => {
    // There is no idempotency key on `POST /api/orders`, so two taps is two dinners
    // and two charges. This is the only thing standing between a customer with a slow
    // connection and that.
    const markup = render({ busy: true })
    expect(markup).toMatch(/<button[^>]*data-submit="1"[^>]*disabled/)
  })

  it('disables the submit for a closed restaurant, beside the sentence saying why', () => {
    const closed = 'Closed right now. Today: 11:30 AM – 3:00 PM.'
    const markup = render({ closedReason: closed })
    expect(markup).toContain(closed)
    expect(markup).toMatch(/<button[^>]*data-submit="1"[^>]*disabled/)
  })

  it('shows a rejection next to the submit, with the cart and the form still there', () => {
    // A 422 is something the customer can act on — a dish sold out while they typed.
    // Losing their cart and their name at that moment is the failure that makes them
    // give up and phone the restaurant instead.
    const markup = render({ error: 'Butter Chicken is sold out' })
    expect(markup).toContain('Butter Chicken is sold out')
    expect(markup).toContain('Butter Chicken')
    expect(markup).toContain('value="Rohan R"')
  })

  it('tells a customer with an empty cart where to go, and shows no form at all', () => {
    const markup = render({ lines: [] })
    expect(markup).toMatch(/nothing in your order/i)
    expect(markup).toContain('/order/kashi')
    // No fields, so there is nothing to fill in and nothing to submit.
    expect(markup).not.toMatch(/data-submit="1"/)
    expect(markup).not.toMatch(/data-consent="1"/)
  })

  it('says nothing about an empty cart until the cart has actually been read', () => {
    // `CartProvider` fills from `localStorage` in an effect, so the first paint of a
    // real cart is legitimately empty. Rendering "your order is empty" into that gap
    // tells a customer their dinner is gone and sends them back to the menu.
    const markup = render({ lines: [], hydrated: false })
    expect(markup).not.toMatch(/nothing in your order/i)
  })
})

describe('PaymentStep', () => {
  function payment(over: Partial<Parameters<typeof PaymentStep>[0]> = {}): string {
    return renderToStaticMarkup(
      <PaymentStep
        shortCode="K7M2"
        orderId="ord-1"
        location={KASHI}
        clientSecret={CLIENT_SECRET}
        onPaid={() => {}}
        {...over}
      />,
    )
  }

  it('mounts the Payment Element on the restaurant’s own account, with this order’s secret', () => {
    const markup = payment()
    // The client secret belongs to an intent on the connected account, so the
    // Stripe.js instance has to be that account's — `stripeBrowser` is the only
    // place that is decided, and this is the call that decides it.
    expect(stripeBrowser).toHaveBeenCalledWith(KASHI.stripeAccountId)
    expect(markup).toContain(`data-client-secret="${CLIENT_SECRET}"`)
    expect(markup).toContain('data-payment-element="1"')
  })

  it('collects the card in Stripe’s own Element and never in a field of ours', () => {
    // SAQ A, structurally: card data must not touch our DOM. An input of ours here
    // would put this product in a different PCI bracket, so the absence is asserted
    // rather than trusted.
    const markup = payment()
    expect(markup).not.toMatch(/<input[^>]*(card|cardnumber|cc-number|cvc|expiry)/i)
  })

  it('shows the short code, and is still not a success screen', () => {
    // The order sits at PENDING_PAYMENT until the webhook says otherwise: nothing has
    // been charged, no ticket has printed and the kitchen has not been told. The code
    // is the only handle the customer has on it meanwhile.
    const markup = payment()
    expect(markup).toContain('K7M2')
    expect(markup).not.toMatch(/thank you for your order|on its way|we’re cooking|paid/i)
  })

  it('says plainly that it cannot take the card when Stripe.js cannot be built', () => {
    // No publishable key at build time, or a restaurant with no connected account.
    // The radio should have been hidden a screen earlier, so reaching here is a
    // misconfiguration — and the answer is the phone number, never a dead form.
    stripeBrowser.mockReturnValueOnce(null)
    const markup = payment()
    expect(markup).not.toContain('data-payment-element="1"')
    expect(markup).toMatch(/(isn’t|is not|can’t|cannot) .*(set up|take the card)/i)
    expect(markup).toContain('(973) 555-0123')
    expect(markup).not.toMatch(/data-pay="1"/)
  })
})

describe('PaymentPaneView', () => {
  function pane(over: Partial<Parameters<typeof PaymentPaneView>[0]> = {}): string {
    return renderToStaticMarkup(
      <PaymentPaneView location={KASHI} ready busy={false} error={null} onPay={() => {}} {...over} />,
    )
  }

  it('disables Pay until Stripe.js has actually loaded', () => {
    // `useStripe()` is null until the script resolves. Tapping Pay in that window
    // does nothing at all, which reads as a broken button on a slow connection.
    expect(pane({ ready: false })).toMatch(/<button[^>]*data-pay="1"[^>]*disabled/)
  })

  it('disables Pay while a confirm is in flight, so nobody confirms twice', () => {
    expect(pane({ busy: true })).toMatch(/<button[^>]*data-pay="1"[^>]*disabled/)
  })

  it('shows the decline inline, with the Element and the button still there to retry', () => {
    // The retry is the same PaymentIntent on the same screen — never a second order,
    // which would be a second dinner and a second charge. So nothing is torn down:
    // the message lands beside a form the customer can use again.
    const markup = pane({ error: 'Your card was declined.' })
    expect(markup).toContain('Your card was declined.')
    expect(markup).toContain('data-payment-element="1"')
    expect(markup).toMatch(/<button[^>]*data-pay="1"/)
    expect(markup).not.toMatch(/<button[^>]*data-pay="1"[^>]*disabled/)
  })

  it('names the restaurant as the merchant, which is what a direct charge means', () => {
    // Their name is on the customer's statement, not ours — that is the whole point
    // of the connected-account charge, and the one place a customer meets it is here.
    expect(pane()).toContain('Kashi')
  })
})
