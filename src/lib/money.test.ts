import { describe, it, expect } from 'vitest'
import {
  roundHalfUp, taxCentsFor, unitPriceCentsFor, lineTotalCentsFor, totalCentsFor, assertTotalsBalance,
  formatCents,
} from './money'

describe('roundHalfUp', () => {
  it('rounds a half up, and anything below it down', () => {
    // The two numbers the plan names. Half-up, not banker's: 174.5 is 175 here and
    // 174 under round-half-to-even, and a tax line that disagrees with the receipt
    // by a cent is a support ticket.
    expect(roundHalfUp(174.5)).toBe(175)
    expect(roundHalfUp(174.4)).toBe(174)
    expect(roundHalfUp(174.6)).toBe(175)
  })

  it('rounds half to even nowhere — both 0.5 cases go up', () => {
    // Banker's rounding would send one of these down. The pair is the test.
    expect(roundHalfUp(0.5)).toBe(1)
    expect(roundHalfUp(1.5)).toBe(2)
    expect(roundHalfUp(2.5)).toBe(3)
  })

  it('leaves whole numbers alone', () => {
    expect(roundHalfUp(350)).toBe(350)
    expect(roundHalfUp(0)).toBe(0)
  })

  it('does not round up the largest double below a half', () => {
    // `Math.floor(v + 0.5)` is the obvious implementation and it is wrong here:
    // 0.49999999999999994 + 0.5 rounds to exactly 1 in binary, so that version
    // answers 1 for a number that is less than a half.
    expect(roundHalfUp(0.49999999999999994)).toBe(0)
  })

  it('refuses a value that is not a finite number', () => {
    // NaN would sail through every later comparison and land as a NULL-ish total.
    expect(() => roundHalfUp(Number.NaN)).toThrow(/finite/i)
    expect(() => roundHalfUp(Number.POSITIVE_INFINITY)).toThrow(/finite/i)
  })
})

describe('taxCentsFor', () => {
  it('taxes the contract order: 4000 at 8875 per 100k is 355', () => {
    // **Re-united 2026-09-21.** The plan said "875 bps", and the rate it meant was
    // New York City's 8.875% — which is 887.5 basis points and therefore not
    // expressible in an integer bps column at all. The unit is now parts per
    // 100,000, the contract order's tax moves 350 → 355 and its total 4850 → 4855,
    // and this line is the one that would have caught the original mistake:
    // 4000 × 8875 / 100000 = 355.0, exactly.
    expect(taxCentsFor(4000, 8875)).toBe(355)
  })

  it('rounds the half up rather than truncating it', () => {
    // 1960 × 8750 / 100000 = 171.5 exactly. Truncation says 171, banker's says 172
    // by luck here, half-up says 172 by rule. 40 × 8750 / 100000 = 3.5 → 4 is the
    // case where truncation and banker's both disagree with us. 8750 is 8.75%: a
    // rate chosen for its ties, not a jurisdiction's.
    expect(taxCentsFor(1960, 8750)).toBe(172)
    expect(taxCentsFor(40, 8750)).toBe(4)
  })

  it('keeps sub-cent fractions exact rather than drifting', () => {
    // 1815 × 8750 / 100000 = 158.8125 — a fraction that no float represents exactly.
    expect(taxCentsFor(1815, 8750)).toBe(159)
    expect(taxCentsFor(1, 8750)).toBe(0)
    // And the real rate on a real price: 1600 × 8875 / 100000 = 142.0.
    expect(taxCentsFor(1600, 8875)).toBe(142)
  })

  it('taxes nothing at nothing, and at a zero rate', () => {
    expect(taxCentsFor(0, 8750)).toBe(0)
    expect(taxCentsFor(4000, 0)).toBe(0)
  })

  it('refuses a negative subtotal or rate', () => {
    // A negative tax is a refund, and a refund is a payment_status, never a total.
    expect(() => taxCentsFor(-1, 8750)).toThrow(/negative/i)
    expect(() => taxCentsFor(4000, -1)).toThrow(/negative/i)
  })

  it('refuses a fractional subtotal — cents are whole', () => {
    expect(() => taxCentsFor(4000.5, 8750)).toThrow(/whole/i)
  })

  it('refuses a subtotal so large the numerator stops being exact', () => {
    // The guard is ten times tighter since the divisor grew: at a 100% rate the
    // numerator leaves safe-integer range just past 9.0e10 cents. Named here so a
    // future rate unit cannot quietly move it again.
    expect(() => taxCentsFor(90_071_992_548, 100_000)).toThrow(/exact integer/i)
    expect(taxCentsFor(90_071_992_547, 100_000)).toBe(90_071_992_547)
  })
})

describe('unitPriceCentsFor', () => {
  it('adds every modifier delta to the base price', () => {
    expect(unitPriceCentsFor(1800, [200])).toBe(2000)
    expect(unitPriceCentsFor(1800, [])).toBe(1800)
    expect(unitPriceCentsFor(1800, [50, 150, 25])).toBe(2025)
  })

  it('lets a delta be negative — a size down is a real modifier', () => {
    expect(unitPriceCentsFor(1800, [-300])).toBe(1500)
  })

  it('refuses to price a unit below zero', () => {
    // order_items has a `unit_price_cents >= 0` CHECK; failing here names the dish
    // instead of surfacing a constraint violation from three layers down.
    expect(() => unitPriceCentsFor(200, [-300])).toThrow(/negative/i)
  })
})

describe('lineTotalCentsFor', () => {
  it('multiplies the unit price by the quantity', () => {
    expect(lineTotalCentsFor(2000, 2)).toBe(4000)
    expect(lineTotalCentsFor(1800, 1)).toBe(1800)
  })

  it('refuses a quantity that is not a whole number above zero', () => {
    expect(() => lineTotalCentsFor(2000, 0)).toThrow(/quantity/i)
    expect(() => lineTotalCentsFor(2000, -1)).toThrow(/quantity/i)
    expect(() => lineTotalCentsFor(2000, 1.5)).toThrow(/quantity/i)
  })
})

describe('totalCentsFor', () => {
  it('totals the plan\'s order: 4000 + 350 + 500 = 4850', () => {
    expect(totalCentsFor({
      subtotalCents: 4000, taxCents: 350, tipCents: 500, deliveryFeeCents: 0, discountCents: 0,
    })).toBe(4850)
  })

  it('adds the delivery fee and subtracts the discount', () => {
    // A discount is stored positive and subtracted — never a negative number.
    expect(totalCentsFor({
      subtotalCents: 4000, taxCents: 350, tipCents: 500, deliveryFeeCents: 399, discountCents: 1000,
    })).toBe(4249)
  })

  it('refuses a discount that would make the total negative', () => {
    expect(() => totalCentsFor({
      subtotalCents: 4000, taxCents: 350, tipCents: 0, deliveryFeeCents: 0, discountCents: 9999,
    })).toThrow(/negative/i)
  })
})

describe('assertTotalsBalance', () => {
  const balanced = {
    subtotalCents: 4000, taxCents: 350, tipCents: 500, deliveryFeeCents: 0, discountCents: 0, totalCents: 4850,
  }

  it('passes the identity it is there to defend', () => {
    expect(() => assertTotalsBalance(balanced)).not.toThrow()
  })

  it('throws when the total does not equal the parts', () => {
    // The bug this traps is not arithmetic, it is assembly: a field copied into the
    // wrong key on the way to the INSERT. So it must be run on the row itself.
    expect(() => assertTotalsBalance({ ...balanced, totalCents: 4851 })).toThrow(/balance/i)
    // Tip dropped from the total — the shape of a real mis-assembly.
    expect(() => assertTotalsBalance({ ...balanced, totalCents: 4350 })).toThrow(/balance/i)
  })

  it('throws on a fractional cent, which no money column can hold', () => {
    expect(() => assertTotalsBalance({
      ...balanced, taxCents: 350.5, totalCents: 4850.5,
    })).toThrow(/whole/i)
  })

  it('throws on a negative component even when the sum happens to balance', () => {
    expect(() => assertTotalsBalance({
      ...balanced, tipCents: -500, totalCents: 3850,
    })).toThrow(/negative/i)
  })
})

describe('formatCents', () => {
  it('writes the cents out as dollars without ever dividing by a hundred', () => {
    expect(formatCents(7351)).toBe('73.51')
    expect(formatCents(551)).toBe('5.51')
    // Under a dollar, and exactly nothing: both need the leading zero the naive
    // string slice would drop.
    expect(formatCents(99)).toBe('0.99')
    expect(formatCents(5)).toBe('0.05')
    expect(formatCents(0)).toBe('0.00')
  })

  it('prints a discount as the negative it becomes on the ticket', () => {
    // Stored positive and subtracted (`orders.ts`); the ticket is where it turns.
    expect(formatCents(-250)).toBe('-2.50')
    expect(formatCents(-5)).toBe('-0.05')
  })

  it('agrees with the float version everywhere the float version is right', () => {
    // The point of not using `(c / 100).toFixed(2)` is not that it is usually wrong —
    // it is that it asks binary floating point for a second opinion on an exact
    // integer. This sweeps the range a restaurant order lives in and pins that the
    // two never disagree, so the replacement is a strict improvement rather than a
    // behaviour change nobody checked.
    for (let cents = 0; cents <= 200_000; cents += 7) {
      expect(formatCents(cents), `${cents} cents`).toBe((cents / 100).toFixed(2))
    }
  })

  it('refuses a fractional cent rather than rounding one away', () => {
    expect(() => formatCents(12.5)).toThrow(/whole/i)
  })
})
