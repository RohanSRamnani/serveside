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
