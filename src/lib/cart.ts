import { lineTotalCentsFor, taxCentsFor, totalCentsFor } from './money'
import type { CartLine } from '@/app/order/[location]/cart-provider'

/**
 * What a cart comes to — **display-only, and computed with the server's own helpers**.
 *
 * Two rules, and the second is what makes the first safe to show a customer:
 *
 * 1. **Nothing here is charged.** `POST /api/orders` re-reads prices, deltas and 86
 *    flags inside the transaction that writes the order and recomputes the tax on the
 *    location row; `order.totalCents` is what Stripe is handed, verbatim. A stale
 *    price on this side is a rejection a customer can act on, never a mischarge.
 * 2. **No money rule is decided in this file.** Every number comes back out of
 *    `@/lib/money` — `lineTotalCentsFor` for a line, `taxCentsFor` for the tax
 *    (half-up, per 100,000), `totalCentsFor` for the sum. The only operator here is
 *    the `+` that adds whole-cent line totals together, which cannot round anything.
 *    A second `×` or a second `/ 100000` is exactly how a preview starts disagreeing
 *    with a receipt by a cent, and a cent is a support ticket.
 *
 * The type-only import of `CartLine` is erased at build time, so this module carries
 * no dependency on the React provider that declares it.
 */

/** The three numbers a cart can honestly show before there is an order to ask about. */
export type CartTotals = {
  subtotalCents: number
  taxCents: number
  /** **Pre-tip.** Tip is collected at checkout and added by the server. */
  totalCents: number
}

/** One line's money: its unit price, modifiers already in it, times its quantity. */
export function lineTotalCents(line: Pick<CartLine, 'unitPriceCents' | 'qty'>): number {
  return lineTotalCentsFor(line.unitPriceCents, line.qty)
}

/**
 * What the lines come to before tax.
 *
 * **The one subtotal in the codebase.** It lived in `cart-provider.tsx` while the
 * bottom bar was the only thing that needed it; the drawer needs the same number, and
 * two functions that happen to agree today are two that can stop agreeing.
 */
export function cartSubtotalCents(lines: readonly CartLine[]): number {
  return lines.reduce((sum, line) => sum + lineTotalCents(line), 0)
}

/**
 * Subtotal, tax and the estimated total — the drawer's footer, and nothing more.
 *
 * `totalCentsFor` rather than `subtotal + tax`, with the three parts this task does
 * not have set to zero: there is **one definition of a total** in this codebase and
 * the drawer must use it, or the day a fee or a discount is added the customer's
 * preview is the one surface that quietly keeps the old sum. Pickup only, so there is
 * genuinely no delivery fee; tip is Task 4's and is added after this.
 *
 * `taxRatePer100k` comes from `StorefrontView` — published on the public view for
 * exactly this, so a cart can show a tax line rather than hiding it until checkout
 * the way the incumbents do.
 */
export function cartTotals(lines: readonly CartLine[], taxRatePer100k: number): CartTotals {
  const subtotalCents = cartSubtotalCents(lines)
  const taxCents = taxCentsFor(subtotalCents, taxRatePer100k)
  return {
    subtotalCents,
    taxCents,
    totalCents: totalCentsFor({
      subtotalCents,
      taxCents,
      tipCents: 0,
      deliveryFeeCents: 0,
      discountCents: 0,
    }),
  }
}
