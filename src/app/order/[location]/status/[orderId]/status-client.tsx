'use client'

import { useEffect, useState } from 'react'
import type { OrderStatus } from '@/domain/order-status'
import { SHELL_CSS } from '../../shell-css'
import { formatPhone, readyAtLabel } from '../../storefront-copy'
import { useCart } from '../../cart-provider'
import {
  STRIP_STEPS, cartArrivalStep, clearedMarkerKey, shouldKeepPolling,
  statusPresentation, type PaymentStatus, type StripStep,
} from '../status-copy'

/**
 * The status page's client half: the poller, and the markup it redraws with.
 *
 * **Split into a stateful `StatusClient` and a fully-controlled `StatusView`**, the
 * same split as `checkout-form.tsx` and for the same reason: there is no jsdom in
 * this suite, so what has to *appear* is rendered to static markup from props alone,
 * while the effects — the poll, `visibilitychange`, the cart clear — are the manual
 * or browser check.
 *
 * `StatusClient` renders from `initial` on its very first pass, and Next server-
 * renders a client component like any other, so the first HTML a customer's phone
 * receives already has the short code, the strip and the quote on it — nobody waits
 * on this file's own `useEffect`s for the first paint, only for the update after.
 */

/** Five seconds — the same cadence `feed-client.tsx` polls the kitchen board on. */
const POLL_MS = 5_000

/** The wire shape, identical to `GET /api/orders/[id]/status`'s response body. */
export type OrderStatusPayload = {
  shortCode: string
  status: OrderStatus
  paymentStatus: PaymentStatus
  quotedReadyAt: string | null
  placedAt: string
}

export type StatusLocation = { name: string; phoneE164: string; timezone: string }

export type StatusClientProps = {
  /** The public storefront slug — both the poll URL and the cart's own partition. */
  slug: string
  orderId: string
  location: StatusLocation
  /** Read on the server, in the same `withLocation` instant as the view — see `page.tsx`. */
  initial: OrderStatusPayload
}

export default function StatusClient({ slug, orderId, location, initial }: StatusClientProps) {
  const [payload, setPayload] = useState<OrderStatusPayload>(initial)
  const cart = useCart()

  /**
   * Clear the cart once, for this arrival — never on a poll tick.
   *
   * **The seam Task 5 handed forward.** `createPaymentIntentFor` enables
   * `automatic_payment_methods`, so a wallet or bank redirect is one Stripe dashboard
   * toggle away, and such a payment returns here directly — the checkout component
   * that would normally call `cart.clear()` never runs again for that path. This page
   * is therefore the only place left that can empty the cart for it, and it has to do
   * so for every arrival, not only that one, because pay-at-pickup and an in-place
   * card confirm already clear the cart themselves and a second `clear()` on an
   * already-empty cart is a no-op.
   *
   * **Gated on `cart.hydrated`, and that gate is load-bearing (fix round 1).** React
   * flushes a child's passive effects before its parent's, and this component is
   * `CartProvider`'s child — so on the very first run, before `CartProvider`'s own
   * hydration effect has read `localStorage`, `cart.clear()` is a guaranteed no-op
   * (`CartProvider`'s `update` refuses to touch a store whose `slug` is still null).
   * Writing the "cleared" marker anyway made that failure permanent, because every
   * later read of the marker found the order already "handled". `cart.hydrated` is
   * the flag `Cart` publishes for exactly this — "no dishes" vs. "have not read
   * storage yet" — so this effect does nothing on that first run and is listed in
   * the dependency array so it runs again the moment hydration flips it to `true`.
   *
   * `cartArrivalStep` is the whole decision **and** the two side effects, pulled out
   * so both are under test without a browser; this effect only supplies the
   * `localStorage` read/write `cartArrivalStep` is handed as plain functions.
   * `clear` is not listed in the deps: it is a stable identity all the way down
   * (`useCallback` over a `useCallback([])` in `cart-provider.tsx`), so omitting it
   * changes nothing about when this runs.
   */
  useEffect(() => {
    let marker: string | null = null
    try {
      marker = window.localStorage.getItem(clearedMarkerKey(slug))
    } catch {
      // Private mode, disabled storage, a getter that throws. `cartArrivalStep`
      // still runs with `marker: null` — the safe direction, since the worst case
      // is a harmless repeat clear() next time, the marker being equally unable to
      // be remembered here.
    }
    cartArrivalStep({
      hydrated: cart.hydrated,
      marker,
      orderId,
      clear: cart.clear,
      writeMarker: (id) => {
        try {
          window.localStorage.setItem(clearedMarkerKey(slug), id)
        } catch {
          // Same as above. Nothing about the order depends on this write succeeding.
        }
      },
    })
  }, [slug, orderId, cart.hydrated])

  /**
   * The poll. `feed-client.tsx`'s own pattern — `fetch` with `cache: 'no-store'`, an
   * `AbortController` released on cleanup — plus two things that page does not need:
   * stopping for good on a terminal status, and pausing while the tab is hidden.
   *
   * **Re-running this effect on every `payload.status` change is the mechanism, not
   * a cost.** Each run's `sync()` closes over the status that effect instance was
   * built with; a status that just turned terminal tears the previous interval down
   * on cleanup and the new instance's guard refuses to start another. There is only
   * ever one `setInterval` alive for this component, and it needs no ref to prove it.
   */
  useEffect(() => {
    const url = `/api/orders/${orderId}/status?location=${encodeURIComponent(slug)}`
    const controller = new AbortController()
    let stopped = false
    let timer: ReturnType<typeof setInterval> | null = null

    async function tick() {
      if (stopped) return
      try {
        const res = await fetch(url, { cache: 'no-store', signal: controller.signal })
        if (res.ok && !stopped) setPayload(await res.json())
      } catch {
        // A dropped connection just tries again at the next tick — the same
        // "say nothing, keep showing what we last knew" choice `feed-client.tsx`
        // makes, and right here for the same reason: a blank screen would read as
        // "your order vanished", which is the one wrong answer this page could give.
      }
    }

    function sync() {
      const shouldRun = shouldKeepPolling(payload.status, document.hidden)
      if (shouldRun && timer === null) timer = setInterval(tick, POLL_MS)
      else if (!shouldRun && timer !== null) {
        clearInterval(timer)
        timer = null
      }
    }

    document.addEventListener('visibilitychange', sync)
    sync()

    return () => {
      stopped = true
      controller.abort()
      document.removeEventListener('visibilitychange', sync)
      if (timer !== null) clearInterval(timer)
    }
  }, [orderId, slug, payload.status])

  return (
    <StatusView
      location={location}
      shortCode={payload.shortCode}
      status={payload.status}
      quotedReadyAt={payload.quotedReadyAt}
    />
  )
}

// ---------------------------------------------------------------------------
// The markup. Pure and fully controlled — renderable from props alone.
// ---------------------------------------------------------------------------

const STEP_LABEL: Record<StripStep, string> = { PLACED: 'Placed', ACCEPTED: 'Accepted', READY: 'Ready' }

export type StatusViewProps = {
  location: StatusLocation
  shortCode: string
  status: OrderStatus
  /** ISO, or `null` — see `statusPresentation`: no promise while unpaid, none once ended. */
  quotedReadyAt: string | null
}

export function StatusView({ location, shortCode, status, quotedReadyAt }: StatusViewProps) {
  const presentation = statusPresentation(status)
  const readyLabel = quotedReadyAt !== null && !presentation.ended
    ? readyAtLabel(new Date(quotedReadyAt), location.timezone)
    : null

  return (
    <div className="ss ss-st" data-slug={location.name}>
      {/* Concatenated into one text node — two children fail hydration; see browse.tsx. */}
      <style>{SHELL_CSS + STATUS_CSS}</style>

      <header className="ss-st-head">
        <p className="ss-st-eyebrow">{location.name}</p>
        <h1 className="ss-st-title">Order status</h1>
      </header>

      <p className="ss-st-code" data-code="1">{shortCode}</p>
      <p className="ss-st-code-hint">Show this at the counter</p>

      <p className="ss-st-headline" data-headline="1">{presentation.headline}</p>
      {presentation.detail ? <p className="ss-st-detail">{presentation.detail}</p> : null}

      {presentation.showStrip ? (
        <ol className="ss-st-strip" data-strip="1">
          {STRIP_STEPS.map((step) => (
            <li
              key={step}
              className="ss-st-step"
              data-step={step}
              data-active={presentation.activeStep === step ? '1' : undefined}
            >
              {STEP_LABEL[step]}
            </li>
          ))}
        </ol>
      ) : null}

      {readyLabel ? <p className="ss-st-ready" data-ready="1">{readyLabel}</p> : null}

      {presentation.ended ? (
        <a className="ss-st-call" data-call="1" href={`tel:${location.phoneE164}`}>
          Call {location.name} — {formatPhone(location.phoneE164)}
        </a>
      ) : (
        <p className="ss-st-tel">
          Something wrong?{' '}
          <a href={`tel:${location.phoneE164}`}>{formatPhone(location.phoneE164)}</a>
        </p>
      )}
    </div>
  )
}

/**
 * The status page's own rules, concatenated onto `SHELL_CSS`. No backticks anywhere
 * inside — this is a template literal, and a Markdown-style code span in a comment
 * ends the string with a build error in the middle of the CSS (see browse.tsx).
 */
export const STATUS_CSS = `
.ss-st { padding: 0 16px calc(28px + env(safe-area-inset-bottom)); max-width: 30rem; margin-inline: auto; }
.ss-st-head { padding: 20px 0 6px; text-align: center; }
.ss-st-eyebrow {
  font-size: 12px; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase;
  color: var(--ink-soft);
}
.ss-st-title {
  margin-top: 4px;
  font-family: ui-serif, "Iowan Old Style", Palatino, Georgia, serif;
  font-size: clamp(20px, 6vw, 24px); font-weight: 600;
}
.ss-st-code {
  margin-top: 18px; text-align: center; font-variant-numeric: tabular-nums;
  font-size: clamp(56px, 22vw, 84px); font-weight: 800; letter-spacing: 0.03em;
  line-height: 1;
}
.ss-st-code-hint {
  margin-top: 6px; text-align: center; font-size: 12.5px; color: var(--ink-soft);
  text-transform: uppercase; letter-spacing: 0.05em;
}
.ss-st-headline {
  margin-top: 24px; text-align: center; font-size: 19px; font-weight: 650;
}
.ss-st-detail { margin-top: 4px; text-align: center; font-size: 14px; color: var(--ink-soft); }
.ss-st-strip { display: flex; margin-top: 22px; list-style: none; gap: 6px; }
.ss-st-step {
  flex: 1; padding: 10px 4px; border-radius: 10px; text-align: center;
  font-size: 12.5px; font-weight: 700; letter-spacing: 0.02em;
  background: var(--card); border: 1px solid var(--line); color: var(--ink-soft);
}
.ss-st-step[data-active="1"] { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
.ss-st-ready { margin-top: 14px; text-align: center; font-size: 14.5px; font-weight: 650; color: var(--diet-ink); }
.ss-st-call {
  display: block; margin-top: 26px; padding: 14px 18px; min-height: 48px;
  border-radius: 12px; background: var(--accent); color: var(--accent-ink);
  text-align: center; font-size: 15.5px; font-weight: 700; line-height: 20px;
}
.ss-st-tel { margin-top: 26px; text-align: center; font-size: 12.5px; color: var(--ink-soft); }
.ss-st-tel a { color: var(--accent); font-weight: 650; }
`
