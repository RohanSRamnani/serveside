'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { lineTotalCentsFor } from '@/lib/money'

/**
 * The cart, which lives entirely in this browser tab and is worth nothing.
 *
 * Three rules hold everything here together:
 *
 * 1. **The cart never computes money the server does not recompute.** Every figure
 *    it produces is display-only. `POST /api/orders` re-reads prices, deltas and 86
 *    flags inside the transaction that writes the order, from the location's one
 *    active menu, and the total on the charge is the total it computed — not this
 *    one. So a stale price here is a rejection a customer can act on, never a
 *    mischarge. (It still uses `@/lib/money`'s helpers rather than its own
 *    arithmetic, so the two paths cannot even disagree by a cent under rounding.)
 * 2. **It holds ids and quantities, plus a copy of what they were called.** The ids
 *    are all the server trusts; the names and the delta are here so a cart can be
 *    drawn without a second round trip, in the same spirit as `order_items`
 *    snapshotting its names.
 * 3. **`localStorage` is a convenience, and it is not trusted.** It survives a
 *    reload, a backgrounded tab and a phone that rang mid-order — the moments carts
 *    are actually lost — but whatever is in it was written by a version of this page
 *    that may no longer exist, so it is shape-checked on the way back in and thrown
 *    away whole if anything is off. Every access is try/caught: Safari in private
 *    mode throws on the getter, and a menu that will not render because storage is
 *    disabled would be a far worse bug than a forgotten cart.
 */

/**
 * One line of the cart, shaped so that `POST /api/orders` can be built from it
 * without a translation step: `menuItemId`, `qty`, `modifierOptionIds` and `notes`
 * are exactly what `CreateOrderInput.items` takes.
 */
export type CartLine = {
  menuItemId: string
  /** What the snapshot called it. Display only — the order path snapshots its own. */
  name: string
  /** Base price plus every chosen modifier's delta, per one of them. Display only. */
  unitPriceCents: number
  qty: number
  modifierOptionIds: string[]
  /** The chosen options' names, in the order they are pinned, for the cart's own lines. */
  modifierNames: string[]
  /** The sum of the chosen deltas, kept so a line can show "+$0.50" without the menu. */
  modifierDeltaCents: number
  notes?: string
}

export type Cart = {
  lines: CartLine[]
  addLine: (line: CartLine) => void
  removeLine: (ix: number) => void
  setQty: (ix: number, qty: number) => void
  clear: () => void
}

/**
 * The same bounds `assertInputShape` enforces on the way in, restated here because
 * this is where a customer meets them: a cart that lets someone build an order the
 * server will refuse is a cart that wastes their time at the last step.
 */
const MAX_QTY_PER_LINE = 999
const MAX_LINES = 100
const MAX_NOTES = 500

// ---------------------------------------------------------------------------
// The decisions, pure, so they can be tested without a browser.
// ---------------------------------------------------------------------------

/**
 * Are these the same line of the cart — that is, may their quantities be added?
 *
 * **Identity is the dish, its modifier set and its note; never the quantity.** One
 * mild and one hot is two dishes to a kitchen, and a note is the difference between
 * a dish and a different dish, so merging across either would print one ticket line
 * and somebody would get the wrong dinner. Modifier order does not count: the set is
 * what was ordered, and the two orders of ticking are the same sandwich.
 */
export function sameLine(a: CartLine, b: CartLine): boolean {
  if (a.menuItemId !== b.menuItemId) return false
  if ((a.notes ?? '') !== (b.notes ?? '')) return false
  if (a.modifierOptionIds.length !== b.modifierOptionIds.length) return false
  const mine = [...a.modifierOptionIds].sort()
  const theirs = [...b.modifierOptionIds].sort()
  return mine.every((id, ix) => id === theirs[ix])
}

/** Adds a line, or bumps the quantity of the line it is indistinguishable from. */
export function addToLines(lines: readonly CartLine[], line: CartLine): CartLine[] {
  const ix = lines.findIndex((existing) => sameLine(existing, line))
  if (ix === -1) {
    // Past the cap the order path refuses the whole order, so the last dish is
    // dropped rather than the cart becoming unorderable. A hundred lines is not a
    // real cart; this is a guard, not a feature.
    if (lines.length >= MAX_LINES) return [...lines]
    return [...lines, { ...line, qty: clampQty(line.qty) }]
  }
  return lines.map((existing, at) => (at === ix
    ? { ...existing, qty: clampQty(existing.qty + line.qty) }
    : existing))
}

/**
 * Sets one line's quantity, and **removes the line at zero** — that is what the
 * minus button on the last one means, and a qty-0 line would be rejected by
 * `assertInputShape` at checkout rather than here.
 */
export function setLineQty(lines: readonly CartLine[], ix: number, qty: number): CartLine[] {
  if (qty < 1) return removeAt(lines, ix)
  return lines.map((line, at) => (at === ix ? { ...line, qty: clampQty(qty) } : line))
}

/** Removes by position. An index that names no line leaves the cart alone. */
export function removeAt(lines: readonly CartLine[], ix: number): CartLine[] {
  if (ix < 0 || ix >= lines.length) return [...lines]
  return lines.filter((_, at) => at !== ix)
}

/**
 * What the lines come to before tax — **display only**, and computed with the same
 * `lineTotalCentsFor` the server prices with rather than a second `×` in this file.
 *
 * Task 3 puts tax and the estimated total beside it (`src/lib/cart.ts`); this is the
 * one number the menu's own bottom bar needs.
 */
export function cartSubtotalCents(lines: readonly CartLine[]): number {
  return lines.reduce((sum, line) => sum + lineTotalCentsFor(line.unitPriceCents, line.qty), 0)
}

/** How many dishes are in the cart, counting quantities — the number on the bar. */
export function cartCount(lines: readonly CartLine[]): number {
  return lines.reduce((sum, line) => sum + line.qty, 0)
}

/**
 * **Keyed by the public slug, so two restaurants' carts cannot mix.** Every
 * storefront is served from the same origin, which means one `localStorage`; a
 * single key would hand a customer the dishes they chose at another restaurant,
 * priced from another menu, and `createOrder` would reject the lot at checkout with
 * nothing on screen explaining why.
 */
export function storageKey(slug: string): string {
  return `serveside.cart.v1.${slug}`
}

/** What is written, so the shape that is read back has a version to check against. */
const STORED_VERSION = 1

/**
 * A stored cart, checked hard enough to render.
 *
 * Returns `[]` for anything it cannot vouch for — absent, unparseable, the wrong
 * version, or one bad line. **One bad line discards the whole cart on purpose:** a
 * partial restore silently drops a dish, and a customer who does not notice pays for
 * a dinner that is missing something. `[]` is a cart they can see is empty.
 */
export function parseStoredLines(raw: string | null): CartLine[] {
  if (raw === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!isRecord(parsed)) return []
  if (parsed.v !== STORED_VERSION) return []
  const lines = parsed.lines
  if (!Array.isArray(lines) || lines.length > MAX_LINES) return []
  const checked: CartLine[] = []
  for (const line of lines) {
    const valid = asCartLine(line)
    if (!valid) return []
    checked.push(valid)
  }
  return checked
}

/** The other half of `parseStoredLines`, so the two cannot drift. */
export function serializeLines(lines: readonly CartLine[]): string {
  return JSON.stringify({ v: STORED_VERSION, lines })
}

function asCartLine(value: unknown): CartLine | null {
  if (!isRecord(value)) return null
  const { menuItemId, name, unitPriceCents, qty, modifierOptionIds, modifierNames, modifierDeltaCents, notes } = value
  if (typeof menuItemId !== 'string' || menuItemId === '') return null
  if (typeof name !== 'string' || name === '') return null
  // Money as a string is the failure this exists to catch: it would render as
  // "$NaN" and add a dish to the cart at no price.
  if (!Number.isSafeInteger(unitPriceCents) || (unitPriceCents as number) < 0) return null
  if (!Number.isInteger(qty) || (qty as number) < 1 || (qty as number) > MAX_QTY_PER_LINE) return null
  if (!isStringArray(modifierOptionIds) || !isStringArray(modifierNames)) return null
  if (!Number.isSafeInteger(modifierDeltaCents)) return null
  if (notes !== undefined && (typeof notes !== 'string' || notes.length > MAX_NOTES)) return null
  const line: CartLine = {
    menuItemId,
    name,
    unitPriceCents: unitPriceCents as number,
    qty: qty as number,
    modifierOptionIds: [...modifierOptionIds],
    modifierNames: [...modifierNames],
    modifierDeltaCents: modifierDeltaCents as number,
  }
  if (notes !== undefined) line.notes = notes
  return line
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function clampQty(qty: number): number {
  return Math.max(1, Math.min(MAX_QTY_PER_LINE, Math.floor(qty)))
}

// ---------------------------------------------------------------------------

const CartContext = createContext<Cart | null>(null)

/**
 * Wraps the menu. One provider per storefront page, keyed by the location's public
 * slug — see `storageKey`.
 */
export function CartProvider({ slug, children }: { slug: string; children: ReactNode }) {
  /**
   * The lines **and the slug they were read for**, in one piece of state.
   *
   * Empty on the first render, on the server and in the browser alike, and filled
   * from storage in an effect afterwards: reading storage during render would make
   * the client's first pass disagree with the server's HTML, which React resolves by
   * throwing the whole tree away — a visible flash of an empty menu on the one
   * screen that has to feel instant.
   *
   * **The slug is in the state rather than in a ref, and that is the fix for a bug
   * this had.** With a `loaded` ref set inside the read effect, the *write* effect
   * ran on the same commit, saw the flag already true, and wrote the first render's
   * empty `lines` — erasing the stored cart a moment before the read's `setLines`
   * landed. Every reload came back to an empty cart. Pairing the lines with the slug
   * they belong to means the write effect can tell "not read yet" from "read, and
   * genuinely empty" by comparing values it renders with, which a ref cannot do.
   */
  const [store, setStore] = useState<{ slug: string | null; lines: CartLine[] }>(
    { slug: null, lines: [] },
  )
  const hydrated = store.slug === slug
  const lines = hydrated ? store.lines : []

  useEffect(() => {
    try {
      setStore({ slug, lines: parseStoredLines(window.localStorage.getItem(storageKey(slug))) })
    } catch {
      // Private mode, disabled storage, a getter that throws. The cart is simply not
      // remembered; the menu is unaffected. Marked read all the same, so what the
      // customer adds from here is at least written back.
      setStore({ slug, lines: [] })
    }
  }, [slug])

  useEffect(() => {
    if (!hydrated) return
    try {
      window.localStorage.setItem(storageKey(slug), serializeLines(lines))
    } catch {
      // Same as above, plus a full quota. Nothing about ordering depends on this.
    }
  }, [slug, lines, hydrated])

  const update = useCallback(
    (next: (lines: readonly CartLine[]) => CartLine[]) => setStore((prev) => (
      // Guards the same race from the other side: a tap that lands between the first
      // paint and the read would otherwise be applied to `[]` and then overwritten.
      prev.slug === null ? prev : { slug: prev.slug, lines: next(prev.lines) }
    )),
    [],
  )
  const addLine = useCallback((line: CartLine) => update((prev) => addToLines(prev, line)), [update])
  const removeLine = useCallback((ix: number) => update((prev) => removeAt(prev, ix)), [update])
  const setQty = useCallback((ix: number, qty: number) => update((prev) => setLineQty(prev, ix, qty)), [update])
  const clear = useCallback(() => update(() => []), [update])

  const value = useMemo<Cart>(
    () => ({ lines, addLine, removeLine, setQty, clear }),
    [lines, addLine, removeLine, setQty, clear],
  )

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>
}

/** The cart, or a loud failure — a silently empty cart is a dish that never got ordered. */
export function useCart(): Cart {
  const cart = useContext(CartContext)
  if (!cart) throw new Error('useCart must be used inside a CartProvider')
  return cart
}
