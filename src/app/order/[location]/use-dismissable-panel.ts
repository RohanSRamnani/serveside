'use client'

import { useEffect } from 'react'
import { NO_PANELS, closePanel, openPanel, type LockStep, type PanelLock } from './panel-lock'

/**
 * Everything a panel over this page does to the page: Escape closes it, and the menu
 * behind it stops scrolling while it is up (a backdrop that scrolls is the commonest
 * way a phone loses a modal).
 *
 * **One copy, because two could not be made correct.** The dish sheet and the cart
 * drawer each carried this effect verbatim, and each cached
 * `document.body.style.overflow` at mount to write back at unmount. Two panels up
 * meant two save/restore pairs over one global, so closing them in the wrong order
 * left the menu permanently unscrollable — see `panel-lock.ts`, which holds the
 * arithmetic and the tests. The count lives in this module, so every panel on the
 * page shares it.
 *
 * **It is not a focus trap, and it does not need to be.** The background is marked
 * `inert` while any panel is open (`browse.tsx`'s `.ss-page` wrapper), so nothing
 * behind the scrim is reachable by Tab, by a screen reader or by a click — which is
 * what makes the panels' `aria-modal="true"` true rather than a claim. What is still
 * missing is the *cycle*: Tab off the last control in a panel goes to the browser's
 * own chrome instead of back to the top of the panel. That is a nuisance, not a way
 * out of the modal, and it is left flagged.
 *
 * `onClose` should be stable (`useCallback`), or this re-runs on every render of the
 * panel's parent. It stays correct if it is not — the release and the re-acquire are
 * balanced — but it is pointless work on a phone.
 */

/**
 * How many panels are open, for the whole page.
 *
 * Module scope on purpose: it is the same piece of global state the lock protects
 * (`document.body`), so it has to be as global as that is. One storefront renders in
 * one tab, and a second `CartProvider` does not change how many bodies there are.
 */
let panels: PanelLock = NO_PANELS

export function useDismissablePanel(onClose: () => void): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    apply(openPanel(panels, document.body.style.overflow))

    return () => {
      window.removeEventListener('keydown', onKey)
      apply(closePanel(panels))
    }
  }, [onClose])
}

/**
 * The one line in this feature that touches the DOM.
 *
 * Nothing else here does, which is why the part that was broken — the counting — is
 * `panel-lock.ts` and is tested as ordinary functions. This wiring is not covered by
 * any test (there is no jsdom in this suite); it is the manual check.
 */
function apply(step: LockStep): void {
  panels = step.lock
  if (step.overflow !== null) document.body.style.overflow = step.overflow
}
