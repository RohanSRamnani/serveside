import { describe, it, expect } from 'vitest'
import { NO_PANELS, closePanel, openPanel, type PanelLock } from './[location]/panel-lock'

/**
 * The scroll lock two panels share, tested as the pure state machine it is — no
 * jsdom, no `document`, because the part that was broken was never the DOM call. It
 * was the arithmetic of who still needs the lock.
 *
 * **The bug this exists to prevent**, which shipped in Task 3's first cut: the dish
 * sheet and the cart drawer each cached `document.body.style.overflow` at mount and
 * wrote it back at unmount. Two panels up meant the second cached `'hidden'` — the
 * first panel's own doing — so closing the first restored `''` while the second was
 * still on screen (the menu scrolls behind a modal), and closing the second then
 * wrote `'hidden'` back over an empty page. The menu stayed unscrollable until a
 * reload, which on a phone looks like the site has died.
 *
 * Both close orders are tested because only one of them was catastrophic, and which
 * one that is depends on an implementation detail nobody should have to reason about
 * twice.
 */

/** Open, then close, applying each step's write to a stand-in for `body.style.overflow`. */
function run(steps: readonly ('open' | 'close')[], initial = ''): { overflow: string; lock: PanelLock } {
  let lock = NO_PANELS
  let overflow = initial
  for (const step of steps) {
    const next = step === 'open' ? openPanel(lock, overflow) : closePanel(lock)
    lock = next.lock
    // `null` is "leave it alone", which is not the same as writing `''` — that
    // distinction is the whole fix.
    if (next.overflow !== null) overflow = next.overflow
  }
  return { overflow, lock }
}

describe('the panel scroll lock', () => {
  it('stops the page scrolling while one panel is up, and gives it back after', () => {
    expect(run(['open']).overflow).toBe('hidden')
    expect(run(['open', 'close']).overflow).toBe('')
  })

  it('restores whatever the page had before, not a guess at it', () => {
    // A page that was deliberately `overflow: scroll` must come back to it. Writing
    // a hardcoded `''` would work on the storefront today and break the first page
    // that sets its own.
    expect(run(['open', 'close'], 'scroll').overflow).toBe('scroll')
  })

  it('holds the lock when the FIRST panel closes first', () => {
    // The catastrophic order. A opens, B opens on top, A closes: the menu must stay
    // locked, because B is still on screen.
    expect(run(['open', 'open', 'close']).overflow).toBe('hidden')
    expect(run(['open', 'open', 'close', 'close']).overflow).toBe('')
  })

  it('holds the lock when the SECOND panel closes first', () => {
    expect(run(['open', 'open', 'close']).overflow).toBe('hidden')
    // Same sequence of calls — the lock does not know or care which panel is which,
    // which is exactly why it cannot get the order wrong.
    expect(run(['open', 'open', 'close', 'close']).overflow).toBe('')
  })

  it('never lets the second panel overwrite what the first remembered', () => {
    // The mechanism of the original bug, isolated: B's open sees `'hidden'` on the
    // page because A put it there. If that were captured as the value to restore,
    // the page would be left locked forever.
    let lock = NO_PANELS
    const first = openPanel(lock, 'scroll')
    lock = first.lock
    const second = openPanel(lock, 'hidden')
    lock = second.lock
    expect(second.overflow).toBeNull()
    expect(closePanel(lock).overflow).toBeNull()
    expect(closePanel(closePanel(lock).lock).overflow).toBe('scroll')
  })

  it('counts three deep and back, since nothing caps how many panels a page has', () => {
    expect(run(['open', 'open', 'open', 'close', 'close']).overflow).toBe('hidden')
    expect(run(['open', 'open', 'open', 'close', 'close', 'close']).overflow).toBe('')
  })

  it('ignores a close no open paid for, rather than going negative', () => {
    // React runs an effect's cleanup exactly once per setup, so this should be
    // unreachable — but a lock that can go to -1 needs two opens before it locks
    // again, and the symptom is a modal that scrolls for no visible reason.
    const stray = closePanel(NO_PANELS)
    expect(stray.overflow).toBeNull()
    expect(stray.lock).toEqual(NO_PANELS)
    expect(run(['close', 'open']).overflow).toBe('hidden')
  })

  it('is a value, not a mutation, so one panel cannot edit another’s idea of the lock', () => {
    const opened = openPanel(NO_PANELS, '')
    expect(NO_PANELS.depth).toBe(0)
    expect(opened.lock).not.toBe(NO_PANELS)
  })
})
