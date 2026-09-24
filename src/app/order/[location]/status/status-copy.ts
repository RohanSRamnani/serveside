import type { OrderStatus } from '@/domain/order-status'

/**
 * The status page's own small domain: what a customer is told for each of the eight
 * order statuses, and the two standing decisions — keep polling? clear the cart? —
 * its client component makes on every tick.
 *
 * A plain module, no `'use client'`, for the same reason `storefront-copy.ts` has
 * none: it is read by a client component and must not drag one behind it. Nothing
 * here touches `localStorage` or `document` itself — every function is a pure
 * decision over values the caller already has, so all of it is testable without a
 * browser (`src/app/order/status.test.tsx`).
 */

/**
 * Money state, spelled out locally. `src/domain/order-status.ts` exports `OrderStatus`
 * because the machine (`transition`, `canTransition`) needs it; there is no equivalent
 * alias for `payment_status`, so this is the one place that needed one.
 */
export type PaymentStatus = 'REQUIRES_PAYMENT' | 'PAID' | 'PAY_ON_PICKUP' | 'REFUNDED'

/**
 * The three lit positions on the strip. `IN_KITCHEN` shares `ACCEPTED`'s position —
 * the same ruling `order-status.ts` documents for the kitchen board: a small kitchen
 * never taps the middle button, and a customer-facing strip has even less room for a
 * step most orders never visibly sit in.
 */
export type StripStep = 'PLACED' | 'ACCEPTED' | 'READY'
export const STRIP_STEPS: readonly StripStep[] = ['PLACED', 'ACCEPTED', 'READY']

/**
 * What one status tells a customer: which step (if any) to light, what the headline
 * and detail say, whether the strip renders at all, and whether this is a dead end
 * the restaurant's phone is the answer to.
 */
export type StatusPresentation = {
  /**
   * `null` while there is nothing yet to light (`PENDING_PAYMENT` — the webhook has
   * not landed) or once the order has ended. An ended order does not point at a step
   * on the happy path, so it is not "stuck" at PLACED — it simply shows no step.
   */
  activeStep: StripStep | null
  /**
   * Render the three-step strip at all. `false` for REJECTED/CANCELED: a strip next
   * to "this order was declined" implies progress is still being made toward READY,
   * which is exactly the wrong thing to imply.
   */
  showStrip: boolean
  headline: string
  detail: string | null
  /** REJECTED or CANCELED — the phone is the next step, not another five-second poll. */
  ended: boolean
}

/**
 * The strip mapping the brief pins by name: PLACED → ACCEPTED → READY, with
 * `PENDING_PAYMENT` showing nothing lit (webhook lag — the money has not landed, so
 * there is nothing to promise yet) and `REJECTED`/`CANCELED` leaving the happy path
 * for an honest dead end rather than a strip stuck on some earlier step.
 *
 * **Exhaustive over the eight statuses on purpose.** Every arm returns and there is
 * no `default`, so a ninth status added to the column fails this function to compile
 * rather than silently falling through to "nothing to show" — the same shape of
 * guarantee `order-status.ts`'s own matrix test gives the transition table.
 */
export function statusPresentation(status: OrderStatus): StatusPresentation {
  switch (status) {
    case 'PENDING_PAYMENT':
      return {
        activeStep: null, showStrip: true, ended: false,
        headline: 'Confirming payment…',
        detail: 'This takes a few seconds — hang tight.',
      }
    case 'NEW':
      return { activeStep: 'PLACED', showStrip: true, ended: false, headline: 'Order placed', detail: null }
    case 'ACCEPTED':
      return {
        activeStep: 'ACCEPTED', showStrip: true, ended: false,
        headline: 'The kitchen has your order', detail: null,
      }
    case 'IN_KITCHEN':
      return { activeStep: 'ACCEPTED', showStrip: true, ended: false, headline: 'On the stove', detail: null }
    case 'READY':
      return { activeStep: 'READY', showStrip: true, ended: false, headline: 'Ready for pickup', detail: null }
    case 'COMPLETED':
      return {
        activeStep: 'READY', showStrip: true, ended: false,
        headline: 'Picked up', detail: 'Thanks for ordering.',
      }
    case 'REJECTED':
      return {
        activeStep: null, showStrip: false, ended: true,
        headline: 'This order was declined',
        detail: 'Call the restaurant to sort it out.',
      }
    case 'CANCELED':
      return {
        activeStep: null, showStrip: false, ended: true,
        headline: 'This order was canceled', detail: null,
      }
  }
}

/**
 * What a pay-at-pickup customer is told on this page: the money is owed at the counter.
 *
 * **This page is the screen a customer keeps** — the one open on their phone as they
 * walk in — so it is where that has to be said. An ordinary pay-at-pickup order chose
 * it; a card order that Stripe could not take was converted to it (the checkout's own
 * sentence for that is on screen only until this page arrives). Both are
 * `PAY_ON_PICKUP` on the row, and the row is all this page is told, so both get the
 * line. "Card or cash" is the checkout's own promise for pay-at-pickup, repeated.
 */
export const PAY_AT_COUNTER_LINE = 'Pay at the counter when you pick up — card or cash.'

/**
 * While the food is still to be collected — and so, on a pay-at-pickup order, the money
 * still to be handed over. **The same set as `KITCHEN_STATUSES`**, restated rather than
 * imported because `order-status.ts` imports the database schema at runtime and this
 * module is read by a client component; `status.test.tsx` pins the two equal.
 */
const STILL_TO_COLLECT: readonly OrderStatus[] = ['NEW', 'ACCEPTED', 'IN_KITCHEN', 'READY']

/**
 * The pay-at-the-counter line for this order, or `null`.
 *
 * Only for `PAY_ON_PICKUP`, and only while the food is still to collect: not once it is
 * collected (paid, at the counter), declined or canceled (nothing to pay for) — "pay at
 * the counter" beside "This order was declined" would send someone to queue for food
 * that is not coming. Never for PAID or a card still being confirmed: asking a customer
 * who paid online to pay again is the one wrong answer that costs them money.
 */
export function paymentNotice(status: OrderStatus, paymentStatus: PaymentStatus): string | null {
  return paymentStatus === 'PAY_ON_PICKUP' && STILL_TO_COLLECT.includes(status) ? PAY_AT_COUNTER_LINE : null
}

/**
 * Statuses with nothing left to poll for. Not the same set as `KITCHEN_STATUSES`
 * (which is about the kitchen board, not this page) even though the two overlap:
 * REJECTED and CANCELED are terminal here exactly as they are there, and are simply
 * where the board and this page happen to agree.
 */
const TERMINAL_STATUSES: readonly OrderStatus[] = ['COMPLETED', 'REJECTED', 'CANCELED']

export function isTerminalStatus(status: OrderStatus): boolean {
  return TERMINAL_STATUSES.includes(status)
}

/**
 * Should the poller's next tick actually fire?
 *
 * Two independent reasons to stand down, and either alone is enough: the order is
 * done telling us anything new (terminal), or the tab is not visible and a poll
 * would spend a customer's battery and data refreshing a screen nobody is looking
 * at. Pure, so both are pinned without a browser or a fake timer.
 */
export function shouldKeepPolling(status: OrderStatus, tabHidden: boolean): boolean {
  return !isTerminalStatus(status) && !tabHidden
}

/**
 * Where the "have we cleared the cart for this order" marker lives — one per
 * storefront slug, the same partition `cart-provider.ts`'s `storageKey` uses, so two
 * restaurants sharing one origin cannot mark each other's carts cleared.
 */
export function clearedMarkerKey(slug: string): string {
  return `serveside.cart-cleared.v1.${slug}`
}

/**
 * Should landing on this status page clear the cart?
 *
 * **Pure — it neither reads nor writes storage itself.** The caller reads the
 * marker once, decides with this, and only on `true` clears the cart and writes the
 * order id back as the new marker. `clearedFor` is whatever order id was last
 * written under this slug, or `null` the first time any order reaches this page in
 * this browser.
 *
 * `true` exactly when the marker does not already name this order — a reload of the
 * same status page is therefore a no-op (idempotent), while a second order at the
 * same restaurant, in the same tab, still gets its own clear. This is the decision
 * Task 5 handed forward: a redirect-based payment method returns here without
 * `checkout-form.tsx`'s own `cart.clear()` ever running, so this page is the only
 * place left that can do it for that path.
 */
export function shouldClearCartOnArrival(orderId: string, clearedFor: string | null): boolean {
  return clearedFor !== orderId
}

/**
 * The whole "clear the cart, once, on arrival" step — not just
 * `shouldClearCartOnArrival`'s sub-decision, but what actually happens once
 * `CartProvider`'s own hydration is accounted for.
 *
 * **Why `hydrated` has to gate this, and not only the marker (fix round 1).**
 * `CartProvider`'s state starts at `{ slug: null, lines: [] }` on every mount, and
 * its `clear()` — like every other mutation — is a deliberate no-op while
 * `store.slug` is still null (`update` in `cart-provider.tsx`, the same guard
 * `shouldPersist` exists for). React flushes a child's passive effects **before**
 * its parent's, and `StatusClient` is `CartProvider`'s child, so calling `clear()`
 * from this effect's very first run — before `CartProvider`'s own hydration effect
 * has read `localStorage` and set a real `slug` — silently does nothing. Writing the
 * "cleared" marker regardless made that failure permanent: every later reload read
 * the marker, decided there was nothing left to clear, and the dishes stayed in the
 * cart forever — invisible in a manual check against an already-empty cart, and the
 * exact case this function exists for (a redirect-based payment returning to a page
 * that just mounted). `hydrated` is exactly the flag `Cart` publishes to tell "no
 * dishes" from "have not read storage yet" apart (see its doc comment), and it is
 * what must gate the *marker write*, not only the clear.
 *
 * `clear` and `writeMarker` are the two side effects, injected rather than called
 * directly, so whether they actually **ran** is itself under test — not just
 * whether the sub-decision was correct.
 */
export function cartArrivalStep(args: {
  hydrated: boolean
  /** The marker already on record for this slug — read by the caller, once, per run. */
  marker: string | null
  orderId: string
  clear: () => void
  writeMarker: (orderId: string) => void
}): { cleared: boolean; wroteMarker: boolean } {
  const { hydrated, marker, orderId, clear, writeMarker } = args
  // Not yet meaningful: `clear()` called now would be the no-op described above, and
  // writing the marker anyway would be the bug. Nothing happens; the effect that
  // calls this runs again once `hydrated` flips true.
  if (!hydrated) return { cleared: false, wroteMarker: false }
  if (!shouldClearCartOnArrival(orderId, marker)) return { cleared: false, wroteMarker: false }
  clear()
  writeMarker(orderId)
  return { cleared: true, wroteMarker: true }
}
