'use client'

import { useEffect, useRef } from 'react'
import { cartTotals, lineTotalCents } from '@/lib/cart'
import { formatCents } from '@/lib/money'
import { MAX_QTY_PER_STEPPER } from '@/lib/order-limits'
import { cartCount, useCart, type CartLine } from './cart-provider'
import { useDismissablePanel } from './use-dismissable-panel'

/**
 * The cart, opened.
 *
 * **Everything it shows about money is display-only**, and the labels are what make
 * that honest rather than sly: the total is marked *estimated — confirmed at
 * payment*, because `POST /api/orders` recomputes prices, deltas and tax inside the
 * transaction that writes the order and that total is the one Stripe is handed. It
 * is also **pre-tip** — the tip is collected at checkout (Task 4) and added by the
 * server. A cart that quietly showed a tip-inclusive "Total" would be wrong in the
 * one direction a customer notices.
 *
 * Nothing in this file does arithmetic. `cartTotals` and `lineTotalCents` come out
 * of `@/lib/cart`, which is `@/lib/money` underneath — the same helpers the server
 * prices with, so the preview and the charge cannot disagree by a cent.
 *
 * **Split into a stateful wrapper and a fully-controlled view**, the same split as
 * the dish sheet and for the same reason: there is no jsdom in this suite, so the
 * markup is what gets tested and it has to be renderable from props alone.
 *
 * It keeps its own CSS beside it rather than in `browse.tsx`'s block. Those rules
 * and this markup are one thing, and the file that owns the rest of the page says
 * why its own styles are inline: class names and the rules they mean must not drift
 * into two places. Scoped under `.ss` like everything else, so the drawer inherits
 * the page's paper and ink and cannot be rendered outside it by accident.
 */

export type CartDrawerViewProps = {
  lines: readonly CartLine[]
  /** From `StorefrontView.location` — published for exactly this. */
  taxRatePer100k: number
  /**
   * `closedNotice(...)` **verbatim**, or `null` when the restaurant is open.
   *
   * Handed down rather than worked out here: the header already tells the customer
   * why the kitchen is shut, and two sentences for one fact drift apart. The one
   * that drifts is always the one nobody reads.
   */
  closedReason: string | null
  onQty: (ix: number, qty: number) => void
  onRemove: (ix: number) => void
  onCheckout: () => void
  onClose: () => void
}

export type CartDrawerProps = {
  taxRatePer100k: number
  closedReason: string | null
  onCheckout: () => void
  onClose: () => void
}

/** The drawer as the page uses it: lines and the two mutators come from the cart. */
export function CartDrawer({ taxRatePer100k, closedReason, onCheckout, onClose }: CartDrawerProps) {
  const cart = useCart()

  // Escape, and the scroll lock the dish sheet shares — a customer meets both as the
  // same kind of panel, and the lock has to be counted rather than copied. See
  // `use-dismissable-panel.ts`.
  useDismissablePanel(onClose)

  return (
    <CartDrawerView
      lines={cart.lines}
      taxRatePer100k={taxRatePer100k}
      closedReason={closedReason}
      onQty={cart.setQty}
      onRemove={cart.removeLine}
      onCheckout={onCheckout}
      onClose={onClose}
    />
  )
}

export function CartDrawerView({
  lines, taxRatePer100k, closedReason, onQty, onRemove, onCheckout, onClose,
}: CartDrawerViewProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const empty = lines.length === 0
  // Not computed for an empty cart: `cartTotals([], rate)` is three honest zeroes,
  // and three $0.00 rows under an empty list is a footer pretending to be a receipt.
  const totals = empty ? null : cartTotals(lines, taxRatePer100k)
  const count = cartCount(lines)

  /**
   * Focus moves into the panel when it opens. **Not a focus trap** — Tab can still
   * reach the menu behind the scrim, which is the same real gap the dish sheet has
   * and a bigger change than it looks (it wants a shared trap for both, and an
   * inert background). What this does buy is that Escape and the close button are
   * reachable at all by someone who is not using a thumb.
   */
  useEffect(() => {
    panelRef.current?.focus()
  }, [])

  return (
    <div className="ss-cart-wrap">
      {/* A real button, so the scrim is dismissible by keyboard as well as by thumb. */}
      <button type="button" className="ss-scrim" aria-label="Close" onClick={onClose} />
      <div
        className="ss-cart"
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Your order"
      >
        <div className="ss-cart-head">
          <h2 className="ss-cart-title">Your order</h2>
          {/* Pickup only — stated once, here, because it is the thing a customer is
              agreeing to and there is no delivery option anywhere to infer it from. */}
          <p className="ss-cart-sub">
            {empty ? 'Pickup' : `Pickup · ${count} ${count === 1 ? 'item' : 'items'}`}
          </p>
          <button type="button" className="ss-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="ss-cart-body">
          {empty ? (
            <p className="ss-cart-empty">
              Nothing in your order yet. Pick something from the menu.
            </p>
          ) : (
            <ul className="ss-cart-lines">
              {lines.map((line, ix) => (
                <CartLineRow
                  // Position, not the dish id: the same dish is legitimately two
                  // lines (one mild, one hot), and a list keyed by dish id would
                  // draw one of them.
                  key={ix}
                  line={line}
                  onQty={(qty) => onQty(ix, qty)}
                  onRemove={() => onRemove(ix)}
                />
              ))}
            </ul>
          )}
        </div>

        {totals ? (
          <div className="ss-cart-foot">
            <dl className="ss-totals">
              <div className="ss-total-row">
                <dt>Subtotal</dt>
                <dd>${formatCents(totals.subtotalCents)}</dd>
              </div>
              <div className="ss-total-row">
                <dt>Tax</dt>
                <dd>${formatCents(totals.taxCents)}</dd>
              </div>
              <div className="ss-total-row" data-total="1">
                <dt>Estimated total</dt>
                <dd>${formatCents(totals.totalCents)}</dd>
              </div>
            </dl>
            {/*
              The one sentence this footer cannot do without. Every number above it
              was computed in a browser from a menu that may be seconds out of date;
              the charge is recomputed on the server from the live menu inside the
              transaction that writes the order. Saying so is cheap, and it is the
              difference between a preview and a promise.
            */}
            <p className="ss-cart-note">estimated — confirmed at payment</p>

            {closedReason ? (
              /*
                The reason sits *beside* the button rather than inside it, which is
                the opposite of the dish sheet's Add — deliberately. A blocked Add is
                an instruction the thumb can act on ("choose a spice level"), so it
                belongs on the button. A closed kitchen is not something the customer
                can fix, and `closedNotice`'s sentences are two sentences long; worn
                as a label they would be a button shouting a paragraph.
              */
              <p className="ss-cart-blocked" role="status">{closedReason}</p>
            ) : null}
            <button
              type="button"
              className="ss-checkout"
              data-checkout="1"
              disabled={closedReason !== null}
              onClick={onCheckout}
            >
              Checkout
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function CartLineRow({ line, onQty, onRemove }: {
  line: CartLine
  onQty: (qty: number) => void
  onRemove: () => void
}) {
  const last = line.qty <= 1

  return (
    <li className="ss-cart-line" data-item={line.menuItemId}>
      <div className="ss-cart-line-main">
        <p className="ss-cart-dish">{line.name}</p>
        {/* What was chosen, in the order the snapshot pins them — the same list the
            kitchen's ticket will carry, so the customer can check it here. */}
        {line.modifierNames.length > 0 ? (
          <p className="ss-cart-mods">{line.modifierNames.join(' · ')}</p>
        ) : null}
        {line.notes ? <p className="ss-cart-note-line">“{line.notes}”</p> : null}
      </div>

      <div className="ss-cart-line-side">
        {/* The line's total, quantity included — the number being committed to, the
            same choice the Add button makes on the dish sheet. */}
        <span className="ss-cart-money">${formatCents(lineTotalCents(line))}</span>
        <div className="ss-stepper ss-cart-stepper">
          {/*
            At one, stepping down means "take it off the order" — `setLineQty`
            already removes at zero, and a minus that greys out at one leaves a
            customer hunting for a second control to undo a tap. The glyph and the
            label both change, so nobody deletes a dish expecting a decrement.
          */}
          <button
            type="button"
            onClick={last ? onRemove : () => onQty(line.qty - 1)}
            aria-label={last ? `Remove ${line.name}` : `One fewer ${line.name}`}
          >
            {last ? <BinIcon /> : '−'}
          </button>
          <span className="ss-qty" aria-live="polite">{line.qty}</span>
          <button
            type="button"
            onClick={() => onQty(line.qty + 1)}
            disabled={line.qty >= MAX_QTY_PER_STEPPER}
            aria-label={`One more ${line.name}`}
          >
            +
          </button>
        </div>
      </div>
    </li>
  )
}

/**
 * A drawn bin, not the wastebasket emoji: an emoji is a different picture in a
 * different palette on every platform, and this page is warm paper and one red.
 * Stroked in `currentColor` so it is the same ink as the `−` it replaces, and
 * `aria-hidden` because the button already says "Remove <dish>".
 */
function BinIcon() {
  return (
    <svg
      className="ss-bin" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"
      fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"
    >
      <path d="M2.7 4.2h10.6M6.3 4.2V2.9h3.4v1.3M4.2 4.2l.6 8.2h6.4l.6-8.2M6.7 6.7v3.4M9.3 6.7v3.4" />
    </svg>
  )
}

/**
 * The drawer's rules, concatenated into `browse.tsx`'s `<style>` block so the page
 * still ships one stylesheet. `.ss-scrim`, `.ss-close`, `.ss-stepper` and `.ss-qty`
 * are the dish sheet's and are reused verbatim: the two panels are the same object
 * to a customer, and a second set of nearly-identical rules is how they stop being.
 */
export const CART_CSS = `
.ss-cart-wrap { position: fixed; inset: 0; z-index: 60; }
.ss-cart {
  position: absolute; inset-inline: 0; bottom: 0;
  display: flex; flex-direction: column; max-height: 92dvh;
  background: var(--paper); border-radius: 20px 20px 0 0;
  box-shadow: 0 -8px 40px rgba(23,18,15,0.28);
}
.ss-cart:focus { outline: none; }
@media (prefers-reduced-motion: no-preference) {
  .ss-cart { animation: ss-rise 260ms cubic-bezier(0.22, 1, 0.36, 1); }
}
.ss-cart-head { position: relative; padding: 18px 16px 12px; border-bottom: 1px solid var(--line); }
.ss-cart-title {
  font-family: ui-serif, "Iowan Old Style", Palatino, Georgia, serif;
  font-size: 21px; font-weight: 600; padding-right: 40px;
}
.ss-cart-sub { margin-top: 3px; font-size: 12.5px; color: var(--ink-soft); }
/*
  flex:1 and min-height:0 together, and both are needed. The grow is what pins the
  totals to the bottom of the full-height side panel at 600px rather than leaving
  them floating under the last dish; the min-height is what lets a flex child
  actually scroll instead of stretching its parent past the screen. On the phone the
  panel is content-height, so the grow has nothing to grow into and the layout is
  unchanged.
*/
.ss-cart-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 4px 16px; -webkit-overflow-scrolling: touch; }
.ss-cart-empty { padding: 28px 4px; font-size: 15px; color: var(--ink-soft); text-align: center; }
.ss-cart-lines { list-style: none; }
.ss-cart-line {
  display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;
  padding: 14px 0; border-bottom: 1px solid var(--line);
}
.ss-cart-line:last-child { border-bottom: 0; }
.ss-cart-line-main { min-width: 0; flex: 1; }
.ss-cart-dish { font-size: 15.5px; font-weight: 650; line-height: 1.25; }
.ss-cart-mods { margin-top: 2px; font-size: 12.5px; line-height: 1.35; color: var(--ink-soft); }
.ss-cart-note-line { margin-top: 3px; font-size: 12.5px; line-height: 1.35; color: var(--ink-soft); font-style: italic; }
.ss-cart-line-side { flex: none; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
.ss-cart-money { font-size: 14.5px; font-weight: 650; font-variant-numeric: tabular-nums; }
/* Shorter than the dish sheet's, which is the page's one primary control; a row of
   full-height steppers would make four dishes a scroll. Still 40px of thumb. */
.ss-cart-stepper button { width: 38px; height: 40px; font-size: 17px; }
.ss-bin { display: block; margin-inline: auto; color: var(--ink-soft); }
.ss-cart-stepper button:hover .ss-bin { color: var(--accent); }
.ss-cart-foot {
  padding: 12px 16px calc(14px + env(safe-area-inset-bottom));
  border-top: 1px solid var(--line); background: var(--paper);
}
.ss-totals { font-size: 14px; }
.ss-total-row { display: flex; justify-content: space-between; gap: 12px; padding: 3px 0; }
.ss-total-row dt { color: var(--ink-soft); }
.ss-total-row dd { font-variant-numeric: tabular-nums; }
.ss-total-row[data-total="1"] { margin-top: 4px; padding-top: 8px; border-top: 1px solid var(--line); }
.ss-total-row[data-total="1"] dt { color: var(--ink); font-weight: 650; }
.ss-total-row[data-total="1"] dd { font-size: 17px; font-weight: 700; }
.ss-cart-note { margin-top: 5px; font-size: 11.5px; color: var(--ink-soft); text-align: right; }
.ss-cart-blocked {
  margin-top: 10px; padding: 8px 10px; border-radius: 10px;
  background: #f4e7e5; color: var(--accent);
  font-size: 12.5px; font-weight: 600;
}
.ss-checkout {
  width: 100%; margin-top: 10px; min-height: 52px; border: 0; border-radius: 12px;
  background: var(--accent); color: var(--accent-ink);
  font: inherit; font-size: 16px; font-weight: 700; cursor: pointer;
}
.ss-checkout:disabled { background: #e7ded3; color: #8a7f74; cursor: default; }

@media (min-width: 600px) {
  .ss-cart {
    inset: 0 0 auto auto; height: 100dvh; max-height: none;
    width: min(420px, 100%); border-radius: 0;
    box-shadow: -8px 0 40px rgba(23,18,15,0.22);
  }
  @media (prefers-reduced-motion: no-preference) {
    .ss-cart { animation: ss-slide-in 260ms cubic-bezier(0.22, 1, 0.36, 1); }
    @keyframes ss-slide-in { from { transform: translateX(18px); opacity: 0.6; } to { transform: none; opacity: 1; } }
  }
}
`
