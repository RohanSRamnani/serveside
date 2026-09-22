'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { cartSubtotalCents, cartTotals, lineTotalCents } from '@/lib/cart'
import { formatCents, roundHalfUp, totalCentsFor } from '@/lib/money'
import { MAX_TEXT_FIELD_LENGTH } from '@/lib/order-limits'
import type { CreateOrderInput } from '@/domain/create-order'
import type { OpenState, ServiceWindow } from '@/domain/hours'
import type { StorefrontLocation } from '@/domain/storefront'
import { useCart, type CartLine } from '../cart-provider'
import { SHELL_CSS } from '../shell-css'
import { closedNotice, formatPhone, menuHref, quoteLabel, statusHref } from '../storefront-copy'

/**
 * Checkout: a name, a phone number, a tip, a consent box and a payment mode.
 *
 * This is the screen with the most ways to do harm in the whole product, and each of
 * the rules below exists because of one of them:
 *
 * - **No accounts, no saved cards, no address.** A guest order is a name, a phone
 *   number and optionally an email. Every extra field is a customer who gives up, and
 *   every stored field is a customer whose data we are now responsible for.
 * - **Pickup only, and not even a hidden delivery control.** The fee is hardcoded 0
 *   in `createOrder` because of it, so a delivery option that "does nothing yet"
 *   would be one CSS change away from taking an order this product cannot fulfil.
 * - **The consent box is separate, unticked, and says what it is.** A pre-ticked box
 *   is not consent, and a marketing opt-in bundled into "place my order" is not
 *   consent either. What is stored is the box *and the moment* — see
 *   `orders.sms_marketing_consent`.
 * - **Every figure here is a preview.** `POST /api/orders` re-reads prices and
 *   recomputes tax inside the transaction that writes the order, and that total is
 *   what Stripe is handed. Nothing on this page is charged, and the total says so.
 * - **Integer cents, never a float.** A customer typing "3.35" into the custom tip is
 *   the one place in this codebase where money arrives as text, so `customTipCents`
 *   reads it as a string. `parseFloat('3.35') * 100` is 334.99999999999994.
 *
 * **Split into a stateful `CheckoutForm` and a fully-controlled `CheckoutFormView`**,
 * the same split as the dish sheet and the cart drawer and for the same reason: there
 * is no jsdom in this suite, so the markup is what gets tested and it has to be
 * renderable from props alone. Everything the form *decides* is an ordinary exported
 * function below, tested as one.
 */

/**
 * Re-exported from `../storefront-copy`, which has no `'use client'` — so the
 * checkout **page** (a server component) can call `quoteLabel` for the first render,
 * which it could not do through this module: every export of a client module is a
 * client reference by the time a server component gets it.
 */
export { checkoutHref, quoteLabel, statusHref } from '../storefront-copy'

// ---------------------------------------------------------------------------
// The decisions, pure.
// ---------------------------------------------------------------------------

/**
 * The tip presets, as percentages of the **pre-tax subtotal**.
 *
 * **Zero is first and is a real option.** A tip screen with no way to decline is the
 * incumbents' dark pattern and it is what an owner gets complained to about; the
 * customer who wants to tip in cash at the counter must be able to say so here
 * without hunting.
 *
 * Percentages of the subtotal rather than the total, because tipping on tax is
 * tipping the state — and because that is what every register in the country does.
 */
export const TIP_PERCENTS = [0, 10, 15, 20] as const

/**
 * A preset tip, in whole cents, **rounded half up** — the same rule `taxCentsFor`
 * uses and for the same reason: one rounding, on one receipt, that a diner compares
 * against a card statement. Banker's rounding would make 10% of $18.45 come to $1.84
 * and the support ticket would be right.
 */
export function tipPresetCents(subtotalCents: number, percent: number): number {
  return roundHalfUp((subtotalCents * percent) / 100)
}

/**
 * How many digits of dollars a custom tip may have. Seven is $9,999,999 — far past
 * any real tip, and comfortably inside exact integer arithmetic once multiplied by
 * 100, which is the only reason there is a bound at all.
 */
const MAX_TIP_DOLLAR_DIGITS = 7

/**
 * Whole cents out of the dollars a customer typed, or `null` if that is not what they
 * typed.
 *
 * **String arithmetic, never a float.** This is the one place in the codebase where
 * money arrives as text, and `parseFloat('3.35') * 100` is 334.99999999999994 — the
 * exact failure `money.ts` exists to keep out of the totals.
 *
 * An empty box is **0, not an error**: that is what the field looks like the instant
 * a customer taps Custom, and refusing it would light up an error before they have
 * typed anything. Anything else that is not a plain dollar amount is `null`, which
 * the form shows as a hint and refuses to submit — never a silent 0, which would be a
 * customer who meant to tip and did not, and a server that was never told.
 */
export function customTipCents(dollars: string): number | null {
  const trimmed = dollars.trim()
  if (trimmed === '') return 0
  const match = new RegExp(`^(\\d{0,${MAX_TIP_DOLLAR_DIGITS}})(?:\\.(\\d{1,2}))?$`).exec(trimmed)
  if (!match) return null
  const [, whole, fraction] = match
  // `'.'` on its own, and `''`, both reach here with nothing in either group.
  if (whole === '' && fraction === undefined) return null
  // `padEnd`, so "3.5" is 50 cents rather than 5.
  return Number(whole === '' ? 0 : whole) * 100 + Number((fraction ?? '').padEnd(2, '0') || 0)
}

/** What the form is currently asking for. One object, so the view takes one prop. */
export type CheckoutFormState = {
  name: string
  phone: string
  email: string
  /** A preset percentage, or `null` when the custom box is the one in play. */
  tipPercent: number | null
  customTip: string
  consent: boolean
  payment: 'card' | 'pay_on_pickup'
}

/**
 * The tip this form is currently asking for, in cents — or `null`, meaning the custom
 * box holds something that is not an amount and the order must not be submitted.
 */
export function tipCentsFor(form: CheckoutFormState, subtotalCents: number): number | null {
  if (form.tipPercent !== null) return tipPresetCents(subtotalCents, form.tipPercent)
  return customTipCents(form.customTip)
}

/**
 * What a US customer types, as E.164 — or `null`, which is a form error they are
 * shown rather than a value that is posted.
 *
 * Nobody types `+15551234567` into a form; they type the number off a phone screen
 * with whatever punctuation their muscle memory supplies. The server refuses anything
 * that is not E.164 (`assertInputShape`), so without this the commonest input in the
 * world is a checkout that fails at the last step for a reason no customer can act on.
 *
 * **US only, and deliberately narrow.** Ten digits, or eleven beginning with the
 * country code. A `+44` number is refused here rather than guessed at, because the
 * alternative is inventing a country code — and a wrong number on a ticket is a
 * dinner going cold beside a phone nobody can be reached on. The *server* accepts any
 * well-formed E.164 number, so widening this later needs no change behind it.
 */
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return null
}

/**
 * The TCPA disclosure, **verbatim**. The wording is the legal artefact, not a label —
 * it is pinned by a test for that reason, and it must not be reworded to fit a layout.
 */
export function consentDisclosure(restaurantName: string): string {
  return `Yes, text me offers and updates from ${restaurantName}. `
    + 'Msg & data rates may apply. Reply STOP to opt out.'
}

/**
 * What a customer is told when `POST /api/orders` did not give us an order.
 *
 * **Pulled out of the submit handler so it can be tested at all.** There is no jsdom
 * in this suite, so the handler itself cannot be driven — and this is the part of it
 * with real judgement in it, where a wrong branch either blames the customer for our
 * outage or tells them to try something that cannot work.
 *
 * - **422 is the customer's to act on** and the route already wrote them a sentence
 *   ("Butter Chicken is sold out"). It is used verbatim; `error` is the stable code
 *   and is for us. A fallback exists because a proxy can return a 422 we did not
 *   write.
 * - **503 is `stripe_account_missing`** — the restaurant has not finished onboarding.
 *   Not the customer's fault and not permanent, and there is a way through it on this
 *   very screen, so the message names it.
 * - **Everything else is ours**, and the wording's job is to say the order did not
 *   happen. A customer who is not sure will either give up or order twice.
 */
export function submitFailureMessage(status: number, body: Record<string, unknown>): string {
  if (status === 422) {
    return typeof body.message === 'string' && body.message !== ''
      ? body.message
      : 'That order can’t be placed right now.'
  }
  if (status === 503) {
    return 'Card payments aren’t set up for this restaurant yet — choose Pay at pickup.'
  }
  return 'Something went wrong on our side. Nothing was ordered — please try again.'
}

/** What a customer is told when the request never arrived anywhere. */
export const NETWORK_FAILURE_MESSAGE =
  'We couldn’t reach the restaurant. Check your connection and try again.'

/**
 * What a customer is told when the order route answered **200** with a body we cannot
 * read.
 *
 * Unreachable by the route's contract, and separate from `submitFailureMessage` on
 * purpose: a 200 means the order was written, so the one thing this may not do is
 * invite a retry. It sends them to the phone instead, which is the only way to find
 * out what happened to an order whose id we did not get.
 */
export const UNREADABLE_SUCCESS_MESSAGE =
  'Your order may have gone through. Please call the restaurant to check before ordering again.'

/**
 * Is there a Stripe publishable key at all?
 *
 * **Blank-safe rather than truthy-safe**, which is Task 5's rule and matters here:
 * an unset Vercel environment variable arrives as `''`, not as `undefined`, and a
 * Payment Element mounted with a blank key throws at runtime — on the one screen that
 * must never break. With no key the Card option is not rendered at all, so pay at
 * pickup is simply the only way to order, which is exactly right for a restaurant
 * that has not finished Stripe onboarding.
 */
export function cardPaymentAvailable(publishableKey: string | undefined): boolean {
  return typeof publishableKey === 'string' && publishableKey.trim() !== ''
}

/**
 * The cart and the form as `POST /api/orders` takes them.
 *
 * Typed as `CreateOrderInput` on purpose — a **type-only** import, erased at build,
 * so this client module carries no dependency on the server half of the app while the
 * compiler still checks the body against the route's real contract. The cart was
 * shaped for this: `menuItemId`, `qty`, `modifierOptionIds` and `notes` are already
 * exactly what `items[]` takes.
 *
 * Blank optional fields are **omitted rather than sent empty**. `contact_email` and
 * `order_items.notes` are nullable columns, and "gave no address" and "gave a blank
 * one" must not become the same row.
 */
export function orderBodyFrom(args: {
  locationId: string
  lines: readonly CartLine[]
  form: CheckoutFormState
  phoneE164: string
  tipCents: number
}): CreateOrderInput {
  const { locationId, lines, form, phoneE164, tipCents } = args
  const email = form.email.trim()
  return {
    locationId,
    channel: 'web',
    // Stated, not inferred. There is no delivery control anywhere on this page, and
    // this is the field that would have to change if there ever were one.
    fulfillment: 'pickup',
    contact: {
      name: form.name.trim(),
      phone: phoneE164,
      ...(email === '' ? {} : { email }),
    },
    items: lines.map((line) => {
      const notes = (line.notes ?? '').trim()
      return {
        menuItemId: line.menuItemId,
        qty: line.qty,
        // Copied, so the posted body cannot alias live cart state.
        modifierOptionIds: [...line.modifierOptionIds],
        ...(notes === '' ? {} : { notes }),
      }
    }),
    tipCents,
    payment: form.payment,
    smsMarketingConsent: form.consent,
  }
}

// ---------------------------------------------------------------------------
// The form.
// ---------------------------------------------------------------------------

export type CheckoutFormProps = {
  /** Resolved from the slug on the server — the view deliberately publishes no id. */
  locationId: string
  location: StorefrontLocation
  open: OpenState
  todayHours: ServiceWindow[]
  /**
   * The quote as the **server** rendered it.
   *
   * Computed there and passed down rather than worked out on the first client render,
   * because `new Date()` on two machines a second apart is a hydration mismatch — and
   * React resolves one by throwing the whole tree away. An effect below re-derives it
   * after mount and every half minute after that, so a customer who sits on this form
   * is never quoted a time that has already passed.
   */
  initialQuote: string
}

/** The default: nothing typed, no tip chosen, no consent, and cash at the counter. */
function blankForm(): CheckoutFormState {
  return {
    name: '',
    phone: '',
    email: '',
    // 15% preselected is the incumbents' trick and it is not ours. Nothing is chosen
    // until a thumb chooses it.
    tipPercent: 0,
    customTip: '',
    // **Unticked.** The one default in this file with legal weight.
    consent: false,
    // Pay at pickup is the mode every restaurant can always do, including one with no
    // Stripe account at all — so it is the one that is safe to start on.
    payment: 'pay_on_pickup',
  }
}

type PlacedCardOrder = { orderId: string; shortCode: string; clientSecret: string }

export function CheckoutForm({ locationId, location, open, todayHours, initialQuote }: CheckoutFormProps) {
  const cart = useCart()
  const router = useRouter()
  const [form, setForm] = useState<CheckoutFormState>(blankForm)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [placed, setPlaced] = useState<PlacedCardOrder | null>(null)
  const [quote, setQuote] = useState(initialQuote)

  /**
   * `process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is written out in full here and
   * nowhere else: Next inlines that expression by **static text substitution** at
   * build time, so a destructured or aliased read is simply `undefined` in the
   * browser — which would hide the Card option on a correctly configured deployment.
   */
  const cardAvailable = cardPaymentAvailable(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY)

  /**
   * The quote, corrected on mount and kept honest while the form is open.
   *
   * The first tick matters as much as the interval: the server's `initialQuote` is
   * however old the response was, and a customer who opened this page on a slow
   * connection should not be promised a time that has already gone.
   */
  useEffect(() => {
    const tick = () => setQuote(quoteLabel(new Date(), location.prepTimeMinutes, location.timezone))
    tick()
    const id = setInterval(tick, 30_000)
    return () => clearInterval(id)
  }, [location.prepTimeMinutes, location.timezone])

  const change = useCallback((patch: Partial<CheckoutFormState>) => {
    setForm((prev) => ({ ...prev, ...patch }))
    // Any edit clears a stale rejection: "Butter Chicken is sold out" must not still
    // be on screen once the customer has done something about it.
    setError(null)
  }, [])

  const submit = useCallback(async () => {
    // **The whole of the double-post guard.** `POST /api/orders` has no idempotency
    // key, so two taps is two dinners and two charges; the button is disabled on
    // `busy` and this is the belt to that braces, for a double-fire the DOM lets
    // through.
    if (busy) return

    const name = form.name.trim()
    if (name === '') return setError('Enter the name the order is under.')
    const phoneE164 = normalizePhone(form.phone)
    if (!phoneE164) return setError('Enter a US phone number, like (555) 123-4567.')
    if (form.email.trim().length > MAX_TEXT_FIELD_LENGTH) {
      return setError('That email address is too long.')
    }
    const tipCents = tipCentsFor(form, cartSubtotalCents(cart.lines))
    if (tipCents === null) return setError('Enter a tip like 4.50, or pick one above.')
    if (cart.lines.length === 0) return setError('Your order is empty.')

    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(orderBodyFrom({ locationId, lines: cart.lines, form, phoneE164, tipCents })),
      })
      // A 500 from a proxy is HTML, not JSON, so parsing is allowed to fail and the
      // status is what decides — never the body's shape.
      const body: Record<string, unknown> = await res.json().catch(() => ({}))

      if (res.status === 200) {
        if (typeof body.orderId === 'string' && typeof body.shortCode === 'string') {
          if (typeof body.clientSecret === 'string') {
            /**
             * A card order, parked at PENDING_PAYMENT. **The cart is deliberately not
             * cleared**: nothing has been paid, and Task 5's Payment Element can
             * still fail or be abandoned — a customer who backs out must find their
             * dishes where they left them.
             */
            setPlaced({ orderId: body.orderId, shortCode: body.shortCode, clientSecret: body.clientSecret })
            return
          }
          // Pay at pickup. The order is already NEW, the kitchen has been told, and
          // the cart's whole purpose is served — so it is emptied before the
          // navigation, or a customer returning to the menu finds a cart they have
          // already ordered.
          cart.clear()
          router.push(statusHref(location.slug, body.orderId))
          return
        }
        /**
         * A 200 whose body we cannot read. **Unreachable by the route's contract**,
         * and handled separately anyway, because the generic failure sentence is the
         * one thing this must never say: a 200 means the order *was* written, so
         * "nothing was ordered" would send somebody off to place a second one. Kept
         * apart from `submitFailureMessage`, which is about responses that are not
         * 200 and may honestly promise that nothing happened.
         */
        setError(UNREADABLE_SUCCESS_MESSAGE)
        setBusy(false)
        return
      }

      // Nothing is cleared on any failure branch — not the cart, not a typed field.
      // Losing both at this moment is what makes somebody give up and phone the
      // restaurant instead.
      setError(submitFailureMessage(res.status, body))
      setBusy(false)
    } catch {
      // The request never arrived, which is the likeliest of all of these on a phone
      // in a basement. The wording has to say the order did not happen.
      setError(NETWORK_FAILURE_MESSAGE)
      setBusy(false)
    }
  }, [busy, form, cart, locationId, location.slug, router])

  if (placed) {
    return <PaymentStep shortCode={placed.shortCode} orderId={placed.orderId} location={location} />
  }

  return (
    <CheckoutFormView
      location={location}
      lines={cart.lines}
      hydrated={cart.hydrated}
      closedReason={closedNotice(open, todayHours)}
      cardAvailable={cardAvailable}
      quote={quote}
      form={form}
      busy={busy}
      error={error}
      onChange={change}
      onSubmit={submit}
    />
  )
}

export type CheckoutFormViewProps = {
  location: StorefrontLocation
  lines: readonly CartLine[]
  /** Whether the cart has been read from storage yet — see `Cart.hydrated`. */
  hydrated: boolean
  /** `closedNotice(...)` verbatim, or null. Handed down so it is one sentence. */
  closedReason: string | null
  cardAvailable: boolean
  quote: string
  form: CheckoutFormState
  busy: boolean
  error: string | null
  onChange: (patch: Partial<CheckoutFormState>) => void
  onSubmit: () => void
}

export function CheckoutFormView({
  location, lines, hydrated, closedReason, cardAvailable, quote, form, busy, error, onChange, onSubmit,
}: CheckoutFormViewProps) {
  const totals = cartTotals(lines, location.taxRatePer100k)
  const tipCents = tipCentsFor(form, totals.subtotalCents)
  const tipInvalid = tipCents === null
  // One definition of a total, as `cart.ts` insists — the drawer's number plus the
  // tip, never a fresh sum. Pickup, so the delivery fee is genuinely zero.
  const grandTotalCents = totalCentsFor({
    subtotalCents: totals.subtotalCents,
    taxCents: totals.taxCents,
    tipCents: tipCents ?? 0,
    deliveryFeeCents: 0,
    discountCents: 0,
  })
  /**
   * An empty cart, but only once the cart has actually been read. `CartProvider`
   * fills from `localStorage` in an effect, so the first paint of a real cart is
   * legitimately empty — telling somebody their order is gone in that gap sends them
   * back to the menu for nothing.
   */
  const empty = hydrated && lines.length === 0

  return (
    <div className="ss ss-co" data-slug={location.slug}>
      {/* Concatenated into one text node — two children fail hydration; see browse.tsx. */}
      <style>{SHELL_CSS + CHECKOUT_CSS}</style>

      <header className="ss-co-head">
        <a className="ss-co-back" href={menuHref(location.slug)}>← Menu</a>
        <h1 className="ss-co-title">Checkout</h1>
        <p className="ss-co-sub">{location.name} · Pickup</p>
      </header>

      {empty ? (
        <div className="ss-co-empty">
          <p className="ss-co-empty-line">There’s nothing in your order yet.</p>
          <a className="ss-co-empty-link" href={menuHref(location.slug)}>Back to the menu</a>
        </div>
      ) : (
        <form
          className="ss-co-form"
          onSubmit={(event) => {
            // A real `<form>`, so Enter in a text field submits it the way a phone
            // keyboard's Go key expects — and prevented, because this posts JSON.
            event.preventDefault()
            onSubmit()
          }}
        >
          <section className="ss-co-block">
            <h2 className="ss-co-h">Your order</h2>
            <ul className="ss-co-lines">
              {lines.map((line, ix) => (
                <li className="ss-co-line" key={ix}>
                  <span className="ss-co-qty">{line.qty}×</span>
                  <span className="ss-co-dish">
                    {line.name}
                    {line.modifierNames.length > 0 ? (
                      <span className="ss-co-mods">{line.modifierNames.join(' · ')}</span>
                    ) : null}
                  </span>
                  {/* `lineTotalCents`, not a `×` written here: no money arithmetic
                      lives outside `@/lib/money` and the helpers over it. */}
                  <span className="ss-co-money">${formatCents(lineTotalCents(line))}</span>
                </li>
              ))}
            </ul>
            <p className="ss-co-quote" data-quote="1">{quote}</p>
          </section>

          <section className="ss-co-block">
            <h2 className="ss-co-h">Who it’s for</h2>
            <label className="ss-co-field">
              <span className="ss-co-label">Name</span>
              <input
                className="ss-co-input"
                name="name"
                type="text"
                autoComplete="name"
                required
                value={form.name}
                onChange={(e) => onChange({ name: e.target.value })}
              />
            </label>
            <label className="ss-co-field">
              <span className="ss-co-label">Mobile number</span>
              <input
                className="ss-co-input"
                name="phone"
                // `tel`, so a phone shows a keypad rather than a keyboard.
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                placeholder="(555) 123-4567"
                required
                value={form.phone}
                onChange={(e) => onChange({ phone: e.target.value })}
              />
              <span className="ss-co-hint">So the kitchen can reach you about this order.</span>
            </label>
            <label className="ss-co-field">
              <span className="ss-co-label">Email <span className="ss-co-optional">optional</span></span>
              <input
                className="ss-co-input"
                name="email"
                type="email"
                autoComplete="email"
                maxLength={MAX_TEXT_FIELD_LENGTH}
                value={form.email}
                onChange={(e) => onChange({ email: e.target.value })}
              />
            </label>
          </section>

          <fieldset className="ss-co-block">
            <legend className="ss-co-h">Tip</legend>
            <p className="ss-co-hint">On the ${formatCents(totals.subtotalCents)} food total, before tax.</p>
            <div className="ss-co-tips">
              {TIP_PERCENTS.map((percent) => (
                <label className="ss-co-tip" key={percent} data-tip={percent}>
                  <input
                    type="radio"
                    name="tip"
                    value={percent}
                    checked={form.tipPercent === percent}
                    onChange={() => onChange({ tipPercent: percent, customTip: '' })}
                  />
                  <span className="ss-co-tip-face">
                    <span className="ss-co-tip-pct">{percent === 0 ? 'None' : `${percent}%`}</span>
                    {percent === 0 ? null : (
                      <span className="ss-co-tip-amt">${formatCents(tipPresetCents(totals.subtotalCents, percent))}</span>
                    )}
                  </span>
                </label>
              ))}
              <label className="ss-co-tip" data-tip="custom">
                <input
                  type="radio"
                  name="tip"
                  value="custom"
                  checked={form.tipPercent === null}
                  onChange={() => onChange({ tipPercent: null })}
                />
                <span className="ss-co-tip-face"><span className="ss-co-tip-pct">Custom</span></span>
              </label>
            </div>
            {form.tipPercent === null ? (
              <label className="ss-co-field ss-co-custom">
                <span className="ss-co-label">Amount</span>
                <span className="ss-co-dollar">
                  <span aria-hidden="true">$</span>
                  <input
                    className="ss-co-input"
                    name="custom-tip"
                    type="text"
                    // `decimal`, so the keypad has a point on it and no minus sign.
                    inputMode="decimal"
                    placeholder="4.50"
                    aria-label="Custom tip in dollars"
                    aria-invalid={tipInvalid}
                    value={form.customTip}
                    onChange={(e) => onChange({ customTip: e.target.value })}
                  />
                </span>
                {tipInvalid ? (
                  <span className="ss-co-hint ss-co-bad" role="status">Enter an amount like 4.50.</span>
                ) : null}
              </label>
            ) : null}
          </fieldset>

          {/*
            **Its own block, and its own heading.** The opt-in is not a line of small
            print under the submit and it is not bundled into placing the order: a
            customer must be able to place this order having read nothing here and
            ticked nothing, and that has to be what the layout looks like too.
          */}
          <section className="ss-co-block ss-co-consent">
            <h2 className="ss-co-h">Text offers <span className="ss-co-optional">optional</span></h2>
            <label className="ss-co-check">
              <input
                type="checkbox"
                data-consent="1"
                name="sms-consent"
                checked={form.consent}
                onChange={(e) => onChange({ consent: e.target.checked })}
              />
              <span className="ss-co-check-copy">{consentDisclosure(location.name)}</span>
            </label>
            <p className="ss-co-hint">
              You’ll get texts about this order either way — this is only for offers.
            </p>
          </section>

          <fieldset className="ss-co-block">
            <legend className="ss-co-h">Payment</legend>
            {cardAvailable ? (
              <label className="ss-co-pay" data-payment="card">
                <input
                  type="radio"
                  name="payment"
                  value="card"
                  checked={form.payment === 'card'}
                  onChange={() => onChange({ payment: 'card' })}
                />
                <span className="ss-co-pay-copy">
                  <span className="ss-co-pay-name">Pay now by card</span>
                  <span className="ss-co-hint">The kitchen starts once the payment clears.</span>
                </span>
              </label>
            ) : null}
            <label className="ss-co-pay" data-payment="pay_on_pickup">
              <input
                type="radio"
                name="payment"
                value="pay_on_pickup"
                checked={form.payment === 'pay_on_pickup'}
                onChange={() => onChange({ payment: 'pay_on_pickup' })}
              />
              <span className="ss-co-pay-copy">
                <span className="ss-co-pay-name">Pay at pickup</span>
                <span className="ss-co-hint">Card or cash at the counter.</span>
              </span>
            </label>
          </fieldset>

          <div className="ss-co-foot">
            <dl className="ss-totals">
              <div className="ss-total-row">
                <dt>Subtotal</dt>
                <dd>${formatCents(totals.subtotalCents)}</dd>
              </div>
              <div className="ss-total-row">
                <dt>Tax</dt>
                <dd>${formatCents(totals.taxCents)}</dd>
              </div>
              <div className="ss-total-row">
                <dt>Tip</dt>
                <dd>{tipCents === null ? '—' : `$${formatCents(tipCents)}`}</dd>
              </div>
              <div className="ss-total-row" data-total="1">
                <dt>Total</dt>
                <dd>${formatCents(grandTotalCents)}</dd>
              </div>
            </dl>
            {/*
              The same sentence the drawer carries, and for the same reason: every
              number above it was computed in a browser from a menu that may be
              seconds out of date, and the charge is recomputed on the server inside
              the transaction that writes the order.
            */}
            <p className="ss-co-note">estimate — the restaurant confirms the total</p>

            {closedReason ? <p className="ss-co-blocked" role="status">{closedReason}</p> : null}
            {error ? <p className="ss-co-error" role="alert">{error}</p> : null}

            <button
              type="submit"
              className="ss-co-submit"
              data-submit="1"
              disabled={busy || closedReason !== null || tipInvalid}
            >
              {busy ? 'Placing your order…' : placeLabel(form.payment, grandTotalCents)}
            </button>
            <p className="ss-co-tel">
              Something wrong?{' '}
              <a href={`tel:${location.phoneE164}`}>{formatPhone(location.phoneE164)}</a>
            </p>
          </div>
        </form>
      )}
    </div>
  )
}

/**
 * What the button says. The number is on it because that is the amount being
 * authorised, and "Place order" alone on a screen with a tip control is how somebody
 * tips 20% by accident.
 */
function placeLabel(payment: CheckoutFormState['payment'], totalCents: number): string {
  return payment === 'card'
    ? `Pay $${formatCents(totalCents)}`
    : `Place order — $${formatCents(totalCents)} at pickup`
}

/**
 * Where a card order lands until Task 5 mounts Stripe's Payment Element.
 *
 * **Deliberately not a success screen.** The order exists and sits at
 * PENDING_PAYMENT: nothing has been charged, no ticket has been printed and the
 * kitchen has not been told — `createOrder` parks card orders there precisely so that
 * none of that happens before the money lands. Saying "thank you for your order"
 * here would be a lie a customer acts on by driving to the restaurant.
 *
 * It shows the short code because that is the only handle they have on an order they
 * cannot yet pay for, and it names the way out, which today is a phone call.
 *
 * TODO(plan-2/task-5): replace this with the Payment Element, mounted on the
 * restaurant's connected account with the `clientSecret` this component's caller is
 * already holding.
 */
export function PaymentStep({ shortCode, orderId, location }: {
  shortCode: string
  orderId: string
  location: StorefrontLocation
}) {
  return (
    <div className="ss ss-co" data-slug={location.slug} data-order={orderId}>
      <style>{SHELL_CSS + CHECKOUT_CSS}</style>
      <div className="ss-co-step">
        <p className="ss-co-step-eyebrow">Order {shortCode}</p>
        <h1 className="ss-co-step-title">Card payment isn’t set up here yet</h1>
        <p className="ss-co-step-copy">
          We’ve held your order under <strong>{shortCode}</strong>, but we can’t take
          the card on this screen yet — so the kitchen hasn’t started it. Call{' '}
          {location.name} on{' '}
          <a href={`tel:${location.phoneE164}`}>{formatPhone(location.phoneE164)}</a>{' '}
          to finish it, or go back and choose <strong>Pay at pickup</strong>.
        </p>
        <a className="ss-co-step-link" href={menuHref(location.slug)}>Back to the menu</a>
      </div>
    </div>
  )
}

/**
 * The checkout's own rules, concatenated onto `SHELL_CSS`. `.ss-totals`,
 * `.ss-total-row` and the tokens are the drawer's and the menu's, reused verbatim:
 * the totals block is the same object to a customer in both places.
 *
 * No backticks anywhere inside — this is a template literal, and a Markdown-style
 * code span in a comment ends the string with a build error in the middle of the CSS.
 */
export const CHECKOUT_CSS = `
.ss-co { padding-bottom: calc(24px + env(safe-area-inset-bottom)); }
.ss-co-head { padding: 14px 16px 10px; border-bottom: 1px solid var(--line); }
.ss-co-back { display: inline-block; font-size: 13.5px; font-weight: 600; color: var(--accent); min-height: 32px; }
.ss-co-title {
  margin-top: 6px;
  font-family: ui-serif, "Iowan Old Style", Palatino, Georgia, serif;
  font-size: clamp(22px, 6vw, 27px); font-weight: 600; letter-spacing: -0.01em;
}
.ss-co-sub { margin-top: 2px; font-size: 13px; color: var(--ink-soft); }
.ss-co-empty { padding: 48px 16px; text-align: center; }
.ss-co-empty-line { font-size: 15.5px; color: var(--ink-soft); }
.ss-co-empty-link {
  display: inline-block; margin-top: 14px; padding: 12px 18px; min-height: 48px;
  border-radius: 12px; background: var(--accent); color: var(--accent-ink);
  font-size: 15.5px; font-weight: 700; line-height: 24px;
}
.ss-co-form { padding: 0 16px; }
.ss-co-block { padding: 16px 0; border-bottom: 1px solid var(--line); border-width: 0 0 1px; }
.ss-co-h {
  font-size: 12px; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase;
  color: var(--ink-soft); padding: 0;
}
.ss-co-optional { font-weight: 600; letter-spacing: 0.02em; text-transform: none; opacity: 0.75; }
.ss-co-lines { list-style: none; margin-top: 10px; }
.ss-co-line { display: flex; align-items: baseline; gap: 10px; padding: 5px 0; font-size: 14.5px; }
.ss-co-qty { flex: none; font-variant-numeric: tabular-nums; color: var(--ink-soft); }
.ss-co-dish { flex: 1; min-width: 0; font-weight: 600; }
.ss-co-mods { display: block; font-size: 12.5px; font-weight: 400; color: var(--ink-soft); }
.ss-co-money { flex: none; font-variant-numeric: tabular-nums; }
.ss-co-quote { margin-top: 10px; font-size: 13.5px; font-weight: 650; color: var(--diet-ink); }
.ss-co-field { display: block; margin-top: 12px; }
.ss-co-label { display: block; font-size: 13px; font-weight: 650; margin-bottom: 4px; }
.ss-co-input {
  width: 100%; min-height: 48px; padding: 11px 12px;
  border: 1px solid var(--line); border-radius: 11px; background: var(--card);
  color: var(--ink); font: inherit;
  /* 16px or iOS zooms the page on focus and never zooms back out. */
  font-size: 16px;
}
.ss-co-input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; border-color: var(--accent); }
.ss-co-hint { display: block; margin-top: 4px; font-size: 12.5px; color: var(--ink-soft); }
.ss-co-bad { color: var(--accent); font-weight: 600; }
.ss-co-dollar { display: flex; align-items: center; gap: 6px; font-size: 16px; color: var(--ink-soft); }
.ss-co-tips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.ss-co-tip { flex: 1 1 64px; }
.ss-co-tip input {
  position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none;
}
.ss-co-tip-face {
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px;
  min-height: 56px; padding: 6px 4px;
  border: 1px solid var(--line); border-radius: 12px; background: var(--card);
  cursor: pointer;
}
.ss-co-tip-pct { font-size: 14.5px; font-weight: 700; }
.ss-co-tip-amt { font-size: 11.5px; color: var(--ink-soft); font-variant-numeric: tabular-nums; }
.ss-co-tip input:checked + .ss-co-tip-face {
  border-color: var(--accent); background: var(--accent); color: var(--accent-ink);
}
.ss-co-tip input:checked + .ss-co-tip-face .ss-co-tip-amt { color: var(--accent-ink); opacity: 0.85; }
.ss-co-tip input:focus-visible + .ss-co-tip-face { outline: 2px solid var(--accent); outline-offset: 2px; }
.ss-co-custom { margin-top: 10px; }
.ss-co-consent { background: #f7f2ea; margin: 0 -16px; padding: 16px; border-bottom: 1px solid var(--line); }
.ss-co-check { display: flex; align-items: flex-start; gap: 10px; margin-top: 10px; cursor: pointer; }
.ss-co-check input {
  flex: none; width: 22px; height: 22px; margin-top: 1px; accent-color: var(--accent);
}
.ss-co-check-copy { font-size: 13.5px; line-height: 1.45; }
.ss-co-pay { display: flex; align-items: flex-start; gap: 10px; margin-top: 10px; cursor: pointer; }
.ss-co-pay input { flex: none; width: 22px; height: 22px; margin-top: 1px; accent-color: var(--accent); }
.ss-co-pay-copy { display: block; }
.ss-co-pay-name { display: block; font-size: 15px; font-weight: 650; }
.ss-co-pay-copy .ss-co-hint { margin-top: 1px; }
.ss-co-foot { padding: 16px 0 8px; }
.ss-totals { font-size: 14px; }
.ss-total-row { display: flex; justify-content: space-between; gap: 12px; padding: 3px 0; }
.ss-total-row dt { color: var(--ink-soft); }
.ss-total-row dd { font-variant-numeric: tabular-nums; }
.ss-total-row[data-total="1"] { margin-top: 4px; padding-top: 8px; border-top: 1px solid var(--line); }
.ss-total-row[data-total="1"] dt { color: var(--ink); font-weight: 650; }
.ss-total-row[data-total="1"] dd { font-size: 18px; font-weight: 700; }
.ss-co-note { margin-top: 5px; font-size: 11.5px; color: var(--ink-soft); text-align: right; }
.ss-co-blocked, .ss-co-error {
  margin-top: 10px; padding: 9px 11px; border-radius: 10px;
  background: #f4e7e5; color: var(--accent); font-size: 13px; font-weight: 600; line-height: 1.4;
}
.ss-co-submit {
  width: 100%; margin-top: 12px; min-height: 54px; border: 0; border-radius: 12px;
  background: var(--accent); color: var(--accent-ink);
  font: inherit; font-size: 16.5px; font-weight: 700; cursor: pointer;
}
.ss-co-submit:disabled { background: #e7ded3; color: #8a7f74; cursor: default; }
.ss-co-tel { margin-top: 12px; font-size: 12.5px; color: var(--ink-soft); text-align: center; }
.ss-co-tel a { color: var(--accent); font-weight: 650; }
.ss-co-step { padding: 40px 16px; max-width: 34rem; margin-inline: auto; }
.ss-co-step-eyebrow {
  font-size: 12px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-soft);
}
.ss-co-step-title {
  margin-top: 8px;
  font-family: ui-serif, "Iowan Old Style", Palatino, Georgia, serif;
  font-size: clamp(22px, 6vw, 28px); font-weight: 600; line-height: 1.15;
}
.ss-co-step-copy { margin-top: 12px; font-size: 15px; line-height: 1.5; color: var(--ink-soft); }
.ss-co-step-copy a { color: var(--accent); font-weight: 650; }
.ss-co-step-link {
  display: inline-block; margin-top: 18px; padding: 13px 18px; min-height: 48px;
  border-radius: 12px; background: var(--accent); color: var(--accent-ink);
  font-size: 15.5px; font-weight: 700; line-height: 22px;
}

@media (min-width: 600px) {
  .ss-co-head, .ss-co-form { max-width: 34rem; margin-inline: auto; }
  .ss-co-consent { margin-inline: -16px; }
}
`
