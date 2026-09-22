import { describe, it, expect } from 'vitest'
import { cartSubtotalCents, cartTotals, lineTotalCents } from './cart'
import type { CartLine } from '@/app/order/[location]/cart-provider'

/**
 * The cart's arithmetic, tested without a browser and without a database, because
 * it is the part that has to be right.
 *
 * Every number here is **display-only** — `POST /api/orders` recomputes the charge
 * from the live menu inside the transaction that writes the order. That is exactly
 * why these tests matter rather than why they do not: a preview that disagrees with
 * the charge is a customer who sees one number and pays another, and the only way
 * the two can be guaranteed to agree is for both to be the same `@/lib/money`
 * helpers over the same integers. A second `×` or a second `/ 100000` in this file
 * would be the bug.
 */

function line(over: Partial<CartLine> = {}): CartLine {
  return {
    menuItemId: 'itm-butter-chicken',
    name: 'Butter Chicken',
    // 1800 base + a 200 modifier delta — the Plan-1 contract line.
    unitPriceCents: 2000,
    qty: 1,
    modifierOptionIds: ['opt-hot'],
    modifierNames: ['Hot'],
    modifierDeltaCents: 200,
    ...over,
  }
}

describe('cartTotals', () => {
  it('totals the contract cart: 2 × (1800 + 200) at 8875 per 100k', () => {
    // The Plan-1 contract cart, and the one case worth writing the numbers out for:
    // 2 × 2000 = 4000 subtotal, 4000 × 8875 / 100000 = 355.0 tax, 4355 total. It is
    // the same cart `money.test.ts` prices and the same cart the spine proof puts
    // through `createOrder`, so a disagreement anywhere is caught by arithmetic
    // rather than by a customer.
    expect(cartTotals([line({ qty: 2 })], 8875)).toEqual({
      subtotalCents: 4000,
      taxCents: 355,
      totalCents: 4355,
    })
  })

  it('is pre-tip, and says so by adding up to exactly subtotal plus tax', () => {
    // Tip is Task 4's, collected at checkout and added by the server. A total here
    // that quietly included one would make the drawer's "estimated" a lie in the
    // one direction a customer notices.
    const totals = cartTotals([line({ qty: 2 })], 8875)
    expect(totals.totalCents).toBe(totals.subtotalCents + totals.taxCents)
  })

  it('adds every line up, each at its own quantity and its own price', () => {
    const totals = cartTotals([
      line({ qty: 2 }),
      line({ menuItemId: 'itm-naan', name: 'Garlic Naan', unitPriceCents: 450, qty: 3, modifierDeltaCents: 0 }),
    ], 8875)
    expect(totals.subtotalCents).toBe(4000 + 1350)
    // 5350 × 8875 / 100000 = 474.8125 → 475.
    expect(totals.taxCents).toBe(475)
    expect(totals.totalCents).toBe(5825)
  })

  it('taxes the half up, the way the server charges it and the way a register does', () => {
    // 1960 × 8750 / 100000 = 171.5 exactly. Truncation says 171 and the receipt
    // would be a cent off the card statement. `taxCentsFor` is the only thing that
    // decides this, which is the point of importing it rather than dividing here.
    expect(cartTotals([line({ unitPriceCents: 1960, qty: 1 })], 8750).taxCents).toBe(172)
  })

  it('comes to nothing on an empty cart rather than to NaN', () => {
    expect(cartTotals([], 8875)).toEqual({ subtotalCents: 0, taxCents: 0, totalCents: 0 })
  })

  it('charges no tax where there is none, without special-casing it', () => {
    expect(cartTotals([line({ qty: 2 })], 0)).toEqual({
      subtotalCents: 4000,
      taxCents: 0,
      totalCents: 4000,
    })
  })

  it('refuses a line it cannot price rather than rendering a number that is not one', () => {
    // A cart restored from `localStorage` is shape-checked on the way in, so this
    // should be unreachable — and if it ever is reached, "$NaN" on a phone is worse
    // than a page that says something went wrong. The refusal is `@/lib/money`'s,
    // not a second set of guards here.
    expect(() => cartTotals([line({ unitPriceCents: 18.5 })], 8875)).toThrow(/whole number of cents/i)
    expect(() => cartTotals([line({ qty: 0 })], 8875)).toThrow(/quantity/i)
  })
})

describe('lineTotalCents', () => {
  it('is what one line comes to: its unit price, modifiers included, times its quantity', () => {
    expect(lineTotalCents(line({ qty: 2 }))).toBe(4000)
    expect(lineTotalCents(line())).toBe(2000)
  })

  it('is the number the subtotal is made of, so a drawer and its footer cannot disagree', () => {
    const lines = [line({ qty: 2 }), line({ unitPriceCents: 450, qty: 3 })]
    const bySumOfLines = lines.reduce((sum, l) => sum + lineTotalCents(l), 0)
    expect(cartTotals(lines, 8875).subtotalCents).toBe(bySumOfLines)
  })
})

describe('cartSubtotalCents', () => {
  it('is the one subtotal in the codebase, and the totals are built on it', () => {
    // It moved here from `cart-provider.tsx` so that the bottom bar's number and the
    // drawer's are the same computation and not two that happen to agree today.
    expect(cartSubtotalCents([line({ qty: 2 }), line({ unitPriceCents: 500, qty: 1 })])).toBe(4500)
    expect(cartSubtotalCents([])).toBe(0)
    expect(cartTotals([line({ qty: 2 })], 8875).subtotalCents).toBe(cartSubtotalCents([line({ qty: 2 })]))
  })
})
