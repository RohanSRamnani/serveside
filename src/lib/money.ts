/**
 * Money. Every value in this file is **integer cents** — there are no dollars in
 * this codebase and no floats in any money column (`orders.ts` rule 1).
 *
 * The arithmetic lives here rather than inside `createOrder` for one reason: it is
 * the part that has to be right. A totals bug is not a broken page, it is a charge
 * that does not match the receipt, and the only cheap way to be sure of it is to
 * test it without a database in the way.
 */

/** Basis points per whole: 875 bps = 8.75%. */
const BPS_PER_WHOLE = 10_000

/**
 * Half **up**, never banker's rounding.
 *
 * Round-half-to-even is the better choice when you are summing thousands of
 * independent roundings and care about the aggregate. We are doing the opposite:
 * one rounding, on one receipt, that a diner compares against a card statement.
 * 8.75% of $17.45 is 174.5 cents and the receipt must say $1.75, the same way
 * every register in the country says it. Banker's would say $1.74 and the support
 * ticket would be right.
 *
 * `Math.round` **is** half-up (ties go toward +∞) and it is specified to return the
 * closest representable answer, which matters for exactly one input: the naive
 * `Math.floor(value + 0.5)` answers 1 for 0.49999999999999994, because that sum
 * rounds up to 1.0 in binary before the floor ever runs.
 *
 * Ties on a negative value go toward zero (`-0.5 → -0`), which is a real asymmetry
 * and a non-issue here: nothing hands this function a negative number — the callers
 * below reject one first, and a refund is a `payment_status`, never a negative total.
 */
export function roundHalfUp(value: number): number {
  if (!Number.isFinite(value)) throw new Error(`roundHalfUp: not a finite number: ${value}`)
  return Math.round(value)
}

/**
 * Sales tax on a subtotal, at the location's rate.
 *
 * `subtotal * bps / 10000` is safe despite the float division: both operands are
 * integers, so the numerator is exact, and the true quotient's only tie values are
 * halves — which binary floating point represents exactly. A division that landed
 * *near* a tie could only do so from an input that differs from the tie by less
 * than 1e-10, and an integer numerator cannot. The safe-integer guard below keeps
 * that argument true by refusing the magnitudes where it would stop being.
 *
 * One flat rate per location, applied to the whole subtotal: `menu_items.taxCategory`
 * exists but nothing reads it yet, and per-category tax is not in this plan.
 */
export function taxCentsFor(subtotalCents: number, taxRateBps: number): number {
  assertWholeCents('subtotal', subtotalCents)
  assertWholeCents('tax rate (bps)', taxRateBps)
  assertNotNegative('subtotal', subtotalCents)
  assertNotNegative('tax rate (bps)', taxRateBps)
  const numerator = subtotalCents * taxRateBps
  if (!Number.isSafeInteger(numerator)) {
    throw new Error(`taxCentsFor: ${subtotalCents} × ${taxRateBps} exceeds exact integer arithmetic`)
  }
  return roundHalfUp(numerator / BPS_PER_WHOLE)
}

/**
 * What one of something costs: the dish plus every modifier chosen on it.
 *
 * Deltas may be negative — a size down is a legitimate modifier — but the unit may
 * not be. `order_items.unit_price_cents >= 0` is a CHECK, and failing here lets the
 * caller name the dish instead of surfacing a constraint violation from the driver.
 */
export function unitPriceCentsFor(basePriceCents: number, modifierDeltaCents: readonly number[]): number {
  assertWholeCents('base price', basePriceCents)
  assertNotNegative('base price', basePriceCents)
  let unit = basePriceCents
  for (const delta of modifierDeltaCents) {
    assertWholeCents('modifier delta', delta)
    unit += delta
  }
  assertNotNegative('unit price', unit)
  return unit
}

/** One line of the order. Quantity is whole and positive — `order_items_qty_positive`. */
export function lineTotalCentsFor(unitPriceCents: number, qty: number): number {
  assertWholeCents('unit price', unitPriceCents)
  assertNotNegative('unit price', unitPriceCents)
  if (!Number.isInteger(qty) || qty < 1) {
    throw new Error(`Line quantity must be a whole number of at least 1, got ${qty}`)
  }
  return unitPriceCents * qty
}

/** The five parts of an order's money, before the total is worked out. */
export type TotalsParts = {
  subtotalCents: number
  taxCents: number
  tipCents: number
  deliveryFeeCents: number
  /** Stored positive and **subtracted**. A discount is never a negative number. */
  discountCents: number
}

/** The same five, plus the total they must add up to. */
export type Totals = TotalsParts & { totalCents: number }

/**
 * Named explicitly rather than read off the object, because the caller hands
 * `assertTotalsBalance` the whole order row — `Object.entries` over that would try
 * to check a location id for being a whole number of cents.
 */
const PART_KEYS = ['subtotalCents', 'taxCents', 'tipCents', 'deliveryFeeCents', 'discountCents'] as const

/** `subtotal + tax + tip + deliveryFee − discount`. The one definition of a total. */
export function totalCentsFor(parts: TotalsParts): number {
  assertPartsAreCents(parts)
  const total = parts.subtotalCents + parts.taxCents + parts.tipCents + parts.deliveryFeeCents - parts.discountCents
  assertNotNegative('total', total)
  return total
}

/**
 * The invariant, checked against the row that is about to be inserted.
 *
 * Not a validation — a customer can do nothing to fail this — and not a restatement
 * of `totalCentsFor` either. The bug it traps is **assembly**: a total computed
 * correctly and then paired with the wrong `tipCents` on the way into the INSERT,
 * or a later task adding a fee to the total and forgetting the column. Run it on the
 * literal values object, immediately before the write, so there is nothing left
 * between the check and the row.
 *
 * Takes the whole row happily — it looks at the six money fields and ignores
 * everything else.
 */
export function assertTotalsBalance(totals: Totals): void {
  assertPartsAreCents(totals)
  assertWholeCents('totalCents', totals.totalCents)
  assertNotNegative('totalCents', totals.totalCents)
  const expected = totals.subtotalCents + totals.taxCents + totals.tipCents
    + totals.deliveryFeeCents - totals.discountCents
  if (expected !== totals.totalCents) {
    throw new Error(
      `Order totals do not balance: ${totals.subtotalCents} + ${totals.taxCents} + ${totals.tipCents} `
      + `+ ${totals.deliveryFeeCents} − ${totals.discountCents} = ${expected}, but total is ${totals.totalCents}`,
    )
  }
}

function assertPartsAreCents(parts: TotalsParts): void {
  for (const key of PART_KEYS) {
    assertWholeCents(key, parts[key])
    assertNotNegative(key, parts[key])
  }
}

function assertWholeCents(label: string, value: number): void {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} must be a whole number of cents, got ${value}`)
  }
}

function assertNotNegative(label: string, value: number): void {
  if (value < 0) throw new Error(`${label} must not be negative, got ${value}`)
}
