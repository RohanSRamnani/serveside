/**
 * Who still needs the page to stop scrolling — the arithmetic behind the modal
 * scroll lock, with no React and no DOM in it so it can be tested as what it is.
 *
 * **It is reference-counted, and that is the whole point.** The storefront has two
 * panels (the dish sheet and the cart drawer) and each one used to cache
 * `document.body.style.overflow` at mount and write it back at unmount. With both up,
 * the second cached `'hidden'` — the first panel's own doing — so closing the first
 * released the lock under a panel that was still on screen, and closing the second
 * then wrote `'hidden'` back over an empty page and left the menu unscrollable until
 * a reload. Two independent save/restore pairs over one piece of shared global state
 * cannot be made correct; a count of holders can.
 *
 * The original value is captured **once, by the first holder**, and handed back
 * **once, to the last**. Everything in between answers `overflow: null`, which means
 * "write nothing" and is deliberately not the same as writing `''`.
 */

export type PanelLock = {
  /** How many panels are open. */
  depth: number
  /** What the page had before the first one opened. `null` when nothing holds it. */
  restore: string | null
}

/** No panels open. Frozen, because it is shared and every step returns a new value. */
export const NO_PANELS: PanelLock = Object.freeze({ depth: 0, restore: null })

/**
 * The next lock, and what to write — `null` for "leave it alone".
 *
 * A step is a value rather than a side effect so the caller owns the one line that
 * touches the DOM, and so this whole file can be tested without one.
 */
export type LockStep = { lock: PanelLock; overflow: string | null }

/**
 * A panel opened. `currentOverflow` is what the page has right now, and it is only
 * believed when this is the **first** holder — read while another panel is up it is
 * that panel's `'hidden'`, and remembering it would lock the page forever.
 */
export function openPanel(lock: PanelLock, currentOverflow: string): LockStep {
  if (lock.depth > 0) {
    return { lock: { depth: lock.depth + 1, restore: lock.restore }, overflow: null }
  }
  return { lock: { depth: 1, restore: currentOverflow }, overflow: 'hidden' }
}

/**
 * A panel closed. The page comes back only when the last holder lets go.
 *
 * A close with nothing open is a no-op rather than a decrement. React runs a
 * cleanup exactly once per setup so it should be unreachable, and a lock that can go
 * to −1 needs two opens before it locks again — a modal that scrolls for no visible
 * reason, which is the kind of bug that gets blamed on the phone.
 */
export function closePanel(lock: PanelLock): LockStep {
  if (lock.depth <= 0) return { lock: NO_PANELS, overflow: null }
  if (lock.depth > 1) {
    return { lock: { depth: lock.depth - 1, restore: lock.restore }, overflow: null }
  }
  return { lock: NO_PANELS, overflow: lock.restore ?? '' }
}
