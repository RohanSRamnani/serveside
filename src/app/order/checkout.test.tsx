import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CartLine } from './[location]/cart-provider'
import type { StorefrontLocation } from '@/domain/storefront'
import {
  CheckoutFormView, NETWORK_FAILURE_MESSAGE, PaymentStep, TIP_PERCENTS,
  UNREADABLE_SUCCESS_MESSAGE, cardPaymentAvailable, checkoutHref, consentDisclosure,
  customTipCents, normalizePhone, orderBodyFrom, quoteLabel, statusHref,
  submitFailureMessage, tipCentsFor, tipPresetCents,
  type CheckoutFormState,
} from './[location]/checkout/checkout-form'

/**
 * The last screen between a hungry person and their dinner, and the one place this
 * product collects anything it can be held to: a phone number, a tip, and an SMS
 * marketing opt-in with legal weight.
 *
 * Split the way `browse.test.tsx` is split, for the same reason — there is no jsdom
 * in this suite, so every decision worth making is an ordinary function and is tested
 * as one, while everything that has to *appear* is rendered to static markup from a
 * fully-controlled view. What is deliberately **not** covered here is the network: the
 * POST, its four failure branches and the navigation afterwards need a browser, and
 * the order route's own DB-backed tests are what prove the body this file builds is
 * one the server accepts.
 */

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
}

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
  it('is false for every shape of a key that is not set', () => {
    // Blank-safe rather than truthy-safe: an unset Vercel env var arrives as `''`,
    // not as undefined, and a Payment Element mounted with a blank key throws at
    // runtime on the one screen that must not break.
    expect(cardPaymentAvailable(undefined)).toBe(false)
    expect(cardPaymentAvailable('')).toBe(false)
    expect(cardPaymentAvailable('   ')).toBe(false)
  })

  it('is true for a real publishable key', () => {
    expect(cardPaymentAvailable('pk_test_abc123')).toBe(true)
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
  it('shows the short code and is honest that the card leg is not wired yet', () => {
    // Task 5 replaces this with the Payment Element. Until it does, the order exists
    // and is at PENDING_PAYMENT, so the screen must not imply it is paid for or that
    // the kitchen has it — and it must show the code, which is the only handle the
    // customer has on an order they cannot yet pay for.
    const markup = renderToStaticMarkup(
      <PaymentStep shortCode="K7M2" orderId="ord-1" location={KASHI} />,
    )
    expect(markup).toContain('K7M2')
    expect(markup).toMatch(/(isn’t|is not|can’t|cannot|not) .*(set up|take the card)/i)
    // Above all not a success screen: nothing has been charged, no ticket has been
    // printed, and the kitchen has not been told. "Thank you for your order" here is
    // a lie a customer acts on by driving to the restaurant.
    expect(markup).not.toMatch(/paid|thank you for your order|on its way|we’re cooking/i)
  })
})
