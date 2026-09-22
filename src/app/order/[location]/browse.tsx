'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { cartSubtotalCents } from '@/lib/cart'
import { formatCents, lineTotalCentsFor, unitPriceCentsFor } from '@/lib/money'
import { MAX_QTY_PER_STEPPER, MAX_TEXT_FIELD_LENGTH } from '@/lib/order-limits'
import type { SnapshotCategory, SnapshotItem, SnapshotModifierGroup } from '@/db/schema'
import type { ServiceWindow, OpenState } from '@/domain/hours'
import type { StorefrontView } from '@/domain/storefront'
import { CART_CSS, CartDrawer } from './cart-drawer'
import { CartProvider, cartCount, useCart, type CartLine } from './cart-provider'
import { useDismissablePanel } from './use-dismissable-panel'

/**
 * A restaurant's menu, on a phone, in the hand of someone who is hungry now.
 *
 * Designed at 390px and widened from there, because that is what the traffic is: a
 * QR code on a table, a link in a text, the "Order Online" button on a Google
 * listing. Everything below follows from that and from the restaurant playbook's
 * measurable bar — the one thing we beat the incumbents on:
 *
 * - **Food first.** The header is three lines and then the menu starts. No hero
 *   image, no marketing, nothing to scroll past.
 * - **Sticky category chips, and the active one tracks the scroll.** Kashi's full
 *   menu is 92 dishes; nobody hunts down a page that long twice.
 * - **Every dish gets a photo slot, a description and its tags as pills** — not as
 *   fine print, because an allergen a customer has to hunt for is an allergen we
 *   hid. A dish with no photo gets the typographic plate, which is a design and not
 *   a placeholder: most independents have photos of four dishes and not forty, and a
 *   grey box forty times reads as a broken website.
 * - **A sold-out dish stays on the menu, marked and unaddable.** Hiding it makes the
 *   restaurant look thinner than it is (`storefrontView` keeps 86'd items for the
 *   same reason).
 *
 * **Everything it renders comes from the pinned snapshot it is handed.** There is no
 * fetch in this file: the server component reads `storefrontView` and passes the
 * whole view down, so the first paint is the menu and the browser never waits on us.
 * `description`, `photoUrl` and `tags` are read through `??` because snapshots
 * pinned before 2026-09-22 legitimately lack them and `menu_snapshots` is immutable.
 *
 * The one thing it enforces that money depends on is the modifier limits, and it
 * enforces them only as a courtesy: `createOrder` re-reads the effective
 * `minSelect`/`maxSelect` inside the transaction that writes the order, so the worst
 * a bug here can do is let a customer build an order the server names its refusal
 * for. It must not be able to produce a wrong price, which is why every figure on
 * this page comes out of `@/lib/money`.
 */

// The note cap and the stepper cap come from `@/lib/order-limits` — the same
// constants `assertInputShape` and the cart read, so a textarea cannot let through
// 600 characters the order path will refuse.

/** Tall enough for the sticky chip rail, so an anchored section lands below it rather than under it. */
const CHIP_OFFSET_PX = 96

// ---------------------------------------------------------------------------
// The decisions, pulled out of the components so they can be tested without a
// browser — the same split as `feed-client.tsx`.
// ---------------------------------------------------------------------------

/** A category's section id, which is also its chip's anchor. One function, so they cannot drift. */
export function anchorId(categoryId: string): string {
  return `menu-${categoryId}`
}

/** The options a customer may actually pick: sold-out ones are shown, and are not among them. */
function pickable(group: SnapshotModifierGroup): number {
  return group.options.filter((option) => !option.is86d).length
}

/**
 * Is this dish orderable at all right now?
 *
 * Two ways to be sold out, and the second is the one that gets missed: the dish
 * itself is 86'd, **or** a group it cannot be ordered without has no option left.
 * On a Friday night both spice levels running out makes the dish unorderable just as
 * surely, and without this the card would invite a tap that can never complete.
 */
export function soldOut(item: SnapshotItem): boolean {
  if (item.is86d) return true
  return item.modifierGroups.some((group) => group.minSelect > 0 && pickable(group) === 0)
}

/** How many of this group's options are ticked. */
function chosenIn(group: SnapshotModifierGroup, selected: readonly string[]): number {
  return group.options.filter((option) => selected.includes(option.id)).length
}

/** Groups still owed an answer, in the order they are pinned. */
function unmet(item: SnapshotItem, selected: readonly string[]): SnapshotModifierGroup[] {
  return item.modifierGroups.filter((group) => chosenIn(group, selected) < group.minSelect)
}

/**
 * Why this dish cannot be added yet, in the words the button will wear — or `null`
 * when it can.
 *
 * **`minSelect` decides whether a group is mandatory; `required` never does.** That
 * is the pinned ruling (`SnapshotModifierGroup.required`): a payload may legitimately
 * say `required: true, minSelect: 0` for an item that opted out of a normally
 * mandatory group, and blocking on `required` would make that dish unorderable.
 *
 * Only the first unanswered group is named. Two instructions at once is a customer
 * reading a form; one is a customer tapping a button.
 *
 * **The group's name is worn as a label, never slotted into a sentence.** The first
 * version of this said `Choose a ${name}`, which is English only when the name is a
 * bare noun — "Choose a Spice Level" reads, but the names restaurants actually write
 * are imperative phrases, and that shape produced "Choose an Add Rice", "Choose a
 * Select a Side" and "Choose a Choose Spice Level". We do not control the wording:
 * Kashi's group names come verbatim from their published ordering data, and this is
 * the primary button on the dish sheet. Name first, instruction after, no article,
 * and every shape reads.
 *
 * The count is what is **still owed**, not the group's total, because after one pick
 * of two "choose 2" reads as though the pick did not register.
 */
export function addBlockedReason(item: SnapshotItem, selected: readonly string[]): string | null {
  if (soldOut(item)) return 'Sold out today'
  const [first] = unmet(item, selected)
  if (!first) return null
  const chosen = chosenIn(first, selected)
  const owed = first.minSelect - chosen
  return `${first.name} — choose ${owed}${chosen > 0 ? ' more' : ''}`
}

/**
 * What one of this dish costs with these options on it.
 *
 * Ids that are not on this dish are ignored rather than priced — a selection can
 * outlive the menu it was made from (a cart restored from `localStorage` after the
 * restaurant rebuilt its snapshot), and pricing an id we cannot find would be
 * inventing a number.
 */
export function dishUnitPriceCents(item: SnapshotItem, selected: readonly string[]): number {
  const deltas = item.modifierGroups
    .flatMap((group) => group.options)
    .filter((option) => selected.includes(option.id))
    .map((option) => option.priceDeltaCents)
  return unitPriceCentsFor(item.basePriceCents, deltas)
}

/** The chosen options, in the order the snapshot pins them — what the cart line carries. */
function chosenOptions(item: SnapshotItem, selected: readonly string[]) {
  return item.modifierGroups
    .flatMap((group) => group.options)
    .filter((option) => selected.includes(option.id))
}

/** What the Add button says. The price is the line's, quantity and all — the number being committed to. */
export function addLabel(unitPriceCents: number, qty: number): string {
  return `Add — $${formatCents(lineTotalCentsFor(unitPriceCents, qty))}`
}

/**
 * Ticking an option, under the group's pinned limits.
 *
 * A one-choice group **replaces** rather than accumulating (it is a radio, and a
 * tapped radio never un-tapping is worse than one that does), and a multi-choice
 * group at its maximum **refuses** the addition rather than quietly dropping the
 * oldest choice: the server enforces the same maximum, so dropping one would be this
 * page deciding which of a customer's choices to throw away.
 */
export function toggleOption(
  group: SnapshotModifierGroup,
  selected: readonly string[],
  optionId: string,
): string[] {
  const mine = group.options.map((option) => option.id)
  const kept = selected.filter((id) => !mine.includes(id))
  const chosen = selected.filter((id) => mine.includes(id))

  if (chosen.includes(optionId)) {
    return [...kept, ...chosen.filter((id) => id !== optionId)]
  }
  if (group.maxSelect <= 1) return [...kept, optionId]
  if (chosen.length >= group.maxSelect) return [...selected]
  return [...kept, ...chosen, optionId]
}

/** The group's limits, said the way a menu says them rather than the way a column does. */
export function selectionHint(group: SnapshotModifierGroup): string {
  const { minSelect: min, maxSelect: max } = group
  if (min === 0) return max <= 1 ? 'Optional' : `Choose up to ${max}`
  if (min === max) return `Choose ${min}`
  return `Choose ${min} to ${max}`
}

/**
 * Allergen words, so an allergen pill can be told from a diet pill.
 *
 * The restaurant's own tag text is never rewritten — Kashi writes "Tree Nuts" and
 * the pill says "Tree Nuts" — this only decides which pill it is, because "contains
 * dairy" and "vegetarian" are opposite kinds of fact and a customer scanning a phone
 * must not have to read them to tell them apart.
 */
const ALLERGENS = [
  'milk', 'dairy', 'egg', 'fish', 'shellfish', 'crustacean', 'tree nut', 'nut',
  'peanut', 'wheat', 'gluten', 'soy', 'sesame', 'mustard', 'celery', 'sulphite', 'sulfite',
]

export type TagPill = { label: string; tone: 'allergen' | 'diet' }

/**
 * A dish's tags as pills. Order-preserving; the card groups them for display.
 *
 * **"Gluten Free" is not gluten**, and a substring match would flag the one tag that
 * means the opposite of the thing it matched. Anything claiming to be free of an
 * allergen, or to be a diet, is a diet pill.
 */
export function tagPills(tags: string[] | undefined): TagPill[] {
  return (tags ?? []).map((label) => {
    const lower = label.toLowerCase()
    const disclaims = /\bfree\b|\bless\b|^no /.test(lower)
    const allergen = !disclaims && ALLERGENS.some((word) => lower.includes(word))
    return { label, tone: allergen ? 'allergen' : 'diet' }
  })
}

/**
 * A phone number as a customer reads one, and **verbatim for anything that is not a
 * plain US number**. `phone_e164` is the storage format and the `tel:` href stays
 * exactly that; this is only the label. A "clever" formatter applied to, say, a
 * +44 number would garble it, so anything that is not `+1` plus ten digits is
 * printed as it was stored.
 */
export function formatPhone(e164: string): string {
  const match = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164)
  if (!match) return e164
  return `(${match[1]}) ${match[2]}-${match[3]}`
}

/** `HH:MM:SS` as a customer reads a clock. `24:00:00` is a legal Postgres `time`. */
function wallClock(time: string): string {
  const [hh, mm] = time.split(':')
  const hour = Number(hh)
  if (hour === 0 || hour === 24) return 'midnight'
  const suffix = hour < 12 ? 'AM' : 'PM'
  const twelve = hour % 12 === 0 ? 12 : hour % 12
  return `${twelve}:${mm} ${suffix}`
}

/**
 * Today's posted hours, as one line. Several windows is the normal case — lunch and
 * dinner are two rows of `business_hours`, not one.
 */
export function formatServiceWindows(windows: readonly ServiceWindow[]): string {
  if (windows.length === 0) return 'Closed today'
  // The dev seed's whole-day grid, and any genuine 24-hour kitchen. "midnight –
  // midnight" is not a sentence anybody has ever read off a door.
  if (windows.length === 1 && windows[0].openTime === '00:00:00' && windows[0].closeTime === '24:00:00') {
    return 'Open 24 hours'
  }
  return windows.map((w) => `${wallClock(w.openTime)} – ${wallClock(w.closeTime)}`).join(', ')
}

/**
 * What a closed restaurant tells a customer — or `null`, which is what an open one
 * says about it.
 *
 * The three reasons stay three sentences. `isOpenAt` goes to real trouble to tell a
 * "we're slammed" pause from a dated closure from the weekly grid, and each one is a
 * different next move for the customer: wait a bit, come back another day, come back
 * later today. Flattening them into "closed" throws away the only part of this the
 * customer can act on.
 */
export function closedNotice(open: OpenState, todayHours: readonly ServiceWindow[]): string | null {
  if (open.open) return null
  if (open.reason === 'paused') {
    return 'Not taking orders right now — the kitchen is slammed. Try again in a little while.'
  }
  if (open.reason === 'holiday' || todayHours.length === 0) return 'Closed today.'
  return `Closed right now. Today: ${formatServiceWindows(todayHours)}.`
}

// ---------------------------------------------------------------------------
// The page.
// ---------------------------------------------------------------------------

export type BrowseProps = {
  /** The whole pinned view, read on the server. There is no fetch in this file. */
  view: StorefrontView
  /** Today's hours at the restaurant, for the header. Empty means none are posted for today. */
  todayHours: ServiceWindow[]
}

export default function Browse({ view, todayHours }: BrowseProps) {
  return (
    <CartProvider slug={view.location.slug}>
      <Menu view={view} todayHours={todayHours} />
    </CartProvider>
  )
}

function Menu({ view, todayHours }: BrowseProps) {
  const { location, open, categories } = view
  const cart = useCart()
  const [openDish, setOpenDish] = useState<SnapshotItem | null>(null)
  const [cartOpen, setCartOpen] = useState(false)
  const active = useActiveCategory(categories)
  const railRef = useActiveChipInView(active)
  /**
   * **One sentence, two places.** The header prints it and the drawer's Checkout
   * button is disabled with it. `closedNotice` is the only thing that knows that a
   * pause, a holiday and the weekly grid are three different next moves for the
   * customer, and a second copy of that wording in the drawer would be the copy that
   * drifts.
   */
  const notice = closedNotice(open, todayHours)

  const add = useCallback((line: CartLine) => {
    cart.addLine(line)
    setOpenDish(null)
  }, [cart])

  /**
   * **Task 4 owns checkout; this is the seam it plugs into.**
   *
   * Deliberately a no-op rather than a `router.push` to a route that does not exist
   * yet: a button that navigates to a 404 is worse than one that does nothing, and
   * the contact/tip/consent step plus `POST /api/orders` is a task, not a href. The
   * button itself is real — it is enabled exactly when the restaurant is open, which
   * is the decision this task owns.
   */
  const checkout = useCallback(() => {
    // TODO(plan-2/task-4): open the checkout step (contact, tip, consent) and POST
    // the cart to /api/orders, which recomputes the money and returns the order.
  }, [])

  /**
   * Stable, because `useDismissablePanel` keys its effect on the identity of the
   * `onClose` it is given. Inline arrows are a new function every render, so the
   * Escape listener and the scroll lock would be torn down and rebuilt on every
   * keystroke in the note field. The lock survives that — releasing and re-acquiring
   * is balanced — but it is pointless work on the device least able to spare it.
   */
  const closeDish = useCallback(() => setOpenDish(null), [])
  const closeCart = useCallback(() => setCartOpen(false), [])

  /**
   * **Any panel makes the menu behind it `inert`**, which is what turns the panels'
   * `aria-modal="true"` from a claim into a fact: nothing behind the scrim can be
   * tabbed to, read by a screen reader or clicked.
   *
   * Without it, and with no focus trap, a keyboard user could Tab from inside the
   * cart drawer onto a dish card behind it and open the dish sheet *underneath* the
   * drawer — `.ss-sheet-wrap` is z-index 50 against the drawer's 60, so the sheet
   * would be up and invisible. That is also the only way two panels are open at
   * once, which is the case the counted scroll lock exists for; both ends of that
   * bug are closed rather than one.
   */
  const panelOpen = cartOpen || openDish !== null

  return (
    <div className="ss" data-slug={location.slug}>
      {/*
        Inline rather than a stylesheet, for the reason `feed-client.tsx` gives about
        its own: this is one screen, and every number in it is a decision about a
        390px phone rather than a theme anything else shares. It also keeps the page
        a single file to read — the class names and the rules they mean cannot drift
        into two places.
      */}
      {/*
        `CSS + CART_CSS`, concatenated into **one** child on purpose. Written as
        `{CSS}{CART_CSS}` it is two text nodes, which the server flattens into one
        run of HTML and the client then fails to hydrate — a whole-page mismatch
        whose message says nothing about a stylesheet.
      */}
      <style>{CSS + CART_CSS}</style>

      {/*
        The menu itself, wrapped so a panel has something to make `inert` — see
        `panelOpen` above. A plain div with no styling of its own: it must not create
        a scroll container, a transform or a containment context, any of which would
        silently stop the sticky chip rail from sticking.
      */}
      <div className="ss-page" inert={panelOpen}>
        <header className="ss-head">
          <div className="ss-head-top">
            <h1 className="ss-name">{location.name}</h1>
            <span className="ss-status" data-open={open.open ? 'true' : 'false'}>
              {open.open ? 'Open now' : 'Closed now'}
            </span>
          </div>
          <p className="ss-meta">
            Pickup · ready in about {location.prepTimeMinutes} min
            {/* The hours are in the notice when there is one; twice is a wasted line
                on the screen where lines are what the food is competing for. */}
            {notice ? null : ` · ${formatServiceWindows(todayHours)}`}
          </p>
          <p className="ss-meta ss-quiet">
            {location.address} ·{' '}
            <a className="ss-tel" href={`tel:${location.phoneE164}`}>{formatPhone(location.phoneE164)}</a>
          </p>
          {notice ? <p className="ss-notice">{notice}</p> : null}
        </header>

        <nav className="ss-chips" aria-label="Menu sections">
          <div className="ss-rail" ref={railRef}>
            {categories.map((category) => (
              <a
                key={category.id}
                className="ss-chip"
                href={`#${anchorId(category.id)}`}
                data-chip={category.id}
                // `page` rather than `true`: the chip is not the current *location*,
                // it is the section of this page you are looking at.
                aria-current={active === category.id ? 'page' : undefined}
              >
                {category.name}
              </a>
            ))}
          </div>
        </nav>

        <main className="ss-main">
          {categories.map((category) => (
            <section
              key={category.id}
              id={anchorId(category.id)}
              className="ss-section"
              data-cat={category.id}
            >
              <h2 className="ss-cat">{category.name}</h2>
              <div className="ss-grid">
                {category.items.map((item) => (
                  <DishCard key={item.id} item={item} onOpen={() => setOpenDish(item)} />
                ))}
              </div>
            </section>
          ))}
        </main>

        {/*
          The cart's handle. It carries the **subtotal**, not the estimated total: a
          tax-inclusive figure needs the word "estimated" beside it to be honest, and
          that label belongs in the drawer where there is room for the sentence. The
          bar states what the dishes come to and opens the place that explains the rest.

          It disappears at zero lines, so the drawer cannot be opened onto an empty
          cart from here — but it can be emptied *while* open, and the drawer says so.
        */}
        {cart.lines.length > 0 ? (
          <button
            type="button"
            className="ss-bar"
            aria-haspopup="dialog"
            aria-expanded={cartOpen}
            onClick={() => setCartOpen(true)}
          >
            <span className="ss-bar-count" aria-live="polite">
              {cartCount(cart.lines)} {cartCount(cart.lines) === 1 ? 'item' : 'items'}
            </span>
            <span className="ss-bar-cta">View order</span>
            <span className="ss-bar-money">${formatCents(cartSubtotalCents(cart.lines))}</span>
          </button>
        ) : null}
      </div>

      {cartOpen ? (
        <CartDrawer
          taxRatePer100k={location.taxRatePer100k}
          closedReason={notice}
          onCheckout={checkout}
          onClose={closeCart}
        />
      ) : null}

      {openDish ? (
        <DishSheet item={openDish} onAdd={add} onClose={closeDish} />
      ) : null}
    </div>
  )
}

function DishCard({ item, onOpen }: { item: SnapshotItem; onOpen: () => void }) {
  const gone = soldOut(item)
  const pills = tagPills(item.tags)
  const diet = pills.filter((pill) => pill.tone === 'diet')
  const allergens = pills.filter((pill) => pill.tone === 'allergen')
  const from = item.modifierGroups.some((group) => group.options.some((o) => o.priceDeltaCents > 0))

  return (
    <article
      className="ss-card"
      data-soldout={gone ? 'true' : 'false'}
      // The wide layout gives a photo the full 4:3 frame and a plate a shallow
      // band. A grid of 4:3 plates is a wall of cream with each dish's name
      // written on it twice, which is the grey-box failure wearing a serif.
      data-photo={item.photoUrl ? 'true' : 'false'}
    >
      <div className="ss-media">
        <DishMedia item={item} />
        {gone ? <span className="ss-gone">Sold out today</span> : null}
      </div>
      <div className="ss-body">
        <h3 className="ss-dish">{item.name}</h3>
        {item.description ? <p className="ss-desc">{item.description}</p> : null}
        {pills.length > 0 ? (
          <ul className="ss-tags">
            {diet.map((pill) => (
              <li key={pill.label} className="ss-tag" data-tag={pill.label} data-tone={pill.tone}>
                {pill.label}
              </li>
            ))}
            {/*
              The allergens and the word that governs them are **one** list item, so
              they wrap as a unit. Split across a line break, "contains" ends up
              orphaned at the end of one row with the thing it qualifies on the next,
              which on an allergen is not a typographic nicety.
            */}
            {allergens.length > 0 ? (
              <li className="ss-contains">
                <span className="ss-tag-label">contains</span>
                {allergens.map((pill) => (
                  <span key={pill.label} className="ss-tag" data-tag={pill.label} data-tone={pill.tone}>
                    {pill.label}
                  </span>
                ))}
              </li>
            ) : null}
          </ul>
        ) : null}
        <p className="ss-price">
          ${formatCents(item.basePriceCents)}
          {from ? <span className="ss-plus-note">+</span> : null}
        </p>
      </div>
      {/*
        The whole card is the tap target — a 104px thumbnail is not — and it is a
        real `<button>` stretched over the card rather than a click handler on the
        article, so it is reachable by keyboard and announces itself. It sits outside
        the heading because a `<button>` may not contain one.
      */}
      <button
        type="button"
        className="ss-hit"
        data-item={item.id}
        disabled={gone}
        onClick={onOpen}
        aria-label={gone ? `${item.name} — sold out today` : `${item.name}, $${formatCents(item.basePriceCents)}`}
      >
        <span className="ss-add-dot" aria-hidden="true">+</span>
      </button>
    </article>
  )
}

/**
 * The photo, or the plate.
 *
 * **The plate is a design, not a placeholder.** Most independent restaurants have
 * good photographs of four dishes and none of the other forty, and forty grey boxes
 * is what makes a menu look broken — so a dish with no photo gets its name set as a
 * printed menu card would set it. It is `aria-hidden` because the name is in the
 * heading immediately below it; a screen reader should not hear the dish twice.
 *
 * A plain `<img>`, deliberately, and not `next/image`: `photoUrl` comes out of a
 * snapshot and may be on any host a restaurant uploaded to, and `next/image` answers
 * a host that is not in `images.remotePatterns` with an error rather than a photo —
 * so the optimiser would have to be opened to every host on the internet (an image
 * proxy anyone may use) to serve a tenant we onboard tomorrow.
 */
function DishMedia({ item }: { item: SnapshotItem }) {
  if (item.photoUrl) {
    return (
      <img
        className="ss-photo"
        src={item.photoUrl}
        alt={item.name}
        loading="lazy"
        decoding="async"
      />
    )
  }
  return (
    <span className="ss-plate" data-plate="typographic" aria-hidden="true">
      <span className="ss-plate-rule" />
      <span className="ss-plate-name">{item.name}</span>
      <span className="ss-plate-rule" />
    </span>
  )
}

// ---------------------------------------------------------------------------
// The dish sheet: state in `DishSheet`, markup in `DishSheetView`.
//
// Split because the markup is the part worth testing and the state is the part that
// needs a browser. A test renders the view in each selection state a customer can
// reach; nothing in this file needs a tap to be proved.
// ---------------------------------------------------------------------------

export type DishSheetViewProps = {
  item: SnapshotItem
  selected: string[]
  qty: number
  notes: string
  onToggle: (group: SnapshotModifierGroup, optionId: string) => void
  onQty: (qty: number) => void
  onNotes: (notes: string) => void
  onAdd: () => void
  onClose: () => void
}

function DishSheet({ item, onAdd, onClose }: {
  item: SnapshotItem
  onAdd: (line: CartLine) => void
  onClose: () => void
}) {
  const [selected, setSelected] = useState<string[]>([])
  const [qty, setQty] = useState(1)
  const [notes, setNotes] = useState('')

  // Escape, and the scroll lock it shares with the cart drawer — one counted lock,
  // not a save/restore pair per panel. See `use-dismissable-panel.ts`.
  useDismissablePanel(onClose)

  const add = () => {
    const options = chosenOptions(item, selected)
    const trimmed = notes.trim()
    onAdd({
      menuItemId: item.id,
      name: item.name,
      unitPriceCents: dishUnitPriceCents(item, selected),
      qty,
      // Pinned order, not tap order, so two customers who chose the same things
      // produce the same line.
      modifierOptionIds: options.map((option) => option.id),
      modifierNames: options.map((option) => option.name),
      modifierDeltaCents: options.reduce((sum, option) => sum + option.priceDeltaCents, 0),
      ...(trimmed === '' ? {} : { notes: trimmed }),
    })
  }

  return (
    <DishSheetView
      item={item}
      selected={selected}
      qty={qty}
      notes={notes}
      onToggle={(group, optionId) => setSelected((prev) => toggleOption(group, prev, optionId))}
      onQty={(next) => setQty(Math.max(1, Math.min(MAX_QTY_PER_STEPPER, next)))}
      onNotes={setNotes}
      onAdd={add}
      onClose={onClose}
    />
  )
}

export function DishSheetView({
  item, selected, qty, notes, onToggle, onQty, onNotes, onAdd, onClose,
}: DishSheetViewProps) {
  const blocked = addBlockedReason(item, selected)
  const unit = dishUnitPriceCents(item, selected)
  const pills = tagPills(item.tags)
  const sheetRef = useRef<HTMLDivElement>(null)

  /**
   * Focus moves into the sheet when it opens. Not a focus trap — Tab can still
   * reach the menu behind the scrim, which is a real gap and a bigger change than
   * it looks — but it is what makes Escape and the close button reachable at all
   * for someone who is not using a thumb.
   */
  useEffect(() => {
    sheetRef.current?.focus()
  }, [])

  return (
    <div className="ss-sheet-wrap">
      {/* A real button, so the scrim is dismissible by keyboard as well as by thumb. */}
      <button type="button" className="ss-scrim" aria-label="Close" onClick={onClose} />
      <div
        className="ss-sheet"
        ref={sheetRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={item.name}
      >
        <div className="ss-sheet-head">
          <div className="ss-sheet-media">
            <DishMedia item={item} />
          </div>
          <div className="ss-sheet-titles">
            <h2 className="ss-sheet-name">{item.name}</h2>
            {item.description ? <p className="ss-sheet-desc">{item.description}</p> : null}
            {/*
              The dish's own price, stated before anything is chosen. The Add button
              carries the line's total, but it is a *blocked* button until a
              mandatory group is answered — so without this a customer can sit on a
              sheet that never tells them what the dish costs.
            */}
            <p className="ss-sheet-price">${formatCents(item.basePriceCents)}</p>
            {pills.length > 0 ? (
              <ul className="ss-tags">
                {pills.map((pill) => (
                  <li key={pill.label} className="ss-tag" data-tag={pill.label} data-tone={pill.tone}>
                    {pill.tone === 'allergen' ? `contains ${pill.label}` : pill.label}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <button type="button" className="ss-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="ss-sheet-body">
          {item.modifierGroups.map((group) => {
            const chosen = chosenIn(group, selected)
            const atCap = group.maxSelect > 1 && chosen >= group.maxSelect
            return (
              <fieldset key={group.id} className="ss-group">
                <legend className="ss-legend">
                  <span className="ss-group-name">{group.name}</span>
                  <span className="ss-group-hint">{selectionHint(group)}</span>
                </legend>
                {group.options.map((option) => (
                  <label key={option.id} className="ss-option" data-off={option.is86d ? 'true' : 'false'}>
                    <input
                      type={group.maxSelect <= 1 ? 'radio' : 'checkbox'}
                      name={group.id}
                      value={option.id}
                      checked={selected.includes(option.id)}
                      disabled={option.is86d || (atCap && !selected.includes(option.id))}
                      onChange={() => onToggle(group, option.id)}
                    />
                    <span className="ss-option-name">
                      {option.name}
                      {option.is86d ? <span className="ss-option-off"> sold out</span> : null}
                    </span>
                    {option.priceDeltaCents !== 0 ? (
                      <span className="ss-option-price">
                        {option.priceDeltaCents > 0 ? '+' : '−'}${formatCents(Math.abs(option.priceDeltaCents))}
                      </span>
                    ) : null}
                  </label>
                ))}
              </fieldset>
            )
          })}

          <label className="ss-note">
            <span className="ss-note-label">Anything we should know?</span>
            <textarea
              className="ss-note-input"
              maxLength={MAX_TEXT_FIELD_LENGTH}
              value={notes}
              onChange={(event) => onNotes(event.target.value)}
              placeholder="No cilantro, extra napkins…"
              rows={2}
            />
            <span className="ss-note-count">{notes.length}/{MAX_TEXT_FIELD_LENGTH}</span>
          </label>
        </div>

        <div className="ss-sheet-foot">
          <div className="ss-stepper">
            <button type="button" onClick={() => onQty(qty - 1)} disabled={qty <= 1} aria-label="One fewer">−</button>
            <span className="ss-qty" aria-live="polite">{qty}</span>
            <button type="button" onClick={() => onQty(qty + 1)} aria-label="One more">+</button>
          </div>
          {/*
            The reason lives *in* the button rather than above it. On a phone the
            button is what the thumb is already on, and "Choose a Spice Level" there
            is an instruction; the same words floating above a dead grey button are a
            complaint. The price comes back the moment it can be committed to.
          */}
          <button
            type="button"
            className="ss-add"
            data-add="1"
            disabled={blocked !== null}
            onClick={onAdd}
          >
            {blocked ?? addLabel(unit, qty)}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Scroll tracking. Browser-only, and the reason the chips are worth having.
// ---------------------------------------------------------------------------

/**
 * Which section the customer is actually looking at.
 *
 * An `IntersectionObserver` rather than a scroll handler: a scroll listener on a
 * 92-dish page runs on every frame of a flick, and this is a phone. The root margin
 * is the trick — the top is pulled in by the height of the sticky rail so a section
 * counts as "arrived" when its heading clears the chips, and the bottom is pulled in
 * by more than half the viewport so the *next* section does not claim the chip the
 * moment it peeks into view.
 */
function useActiveCategory(categories: SnapshotCategory[]): string | null {
  const [active, setActive] = useState<string | null>(categories[0]?.id ?? null)

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return
    const visible = new Set<string>()
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.cat
        if (!id) continue
        if (entry.isIntersecting) visible.add(id)
        else visible.delete(id)
      }
      // The topmost section in view wins, in the menu's own order — never "the last
      // one the observer mentioned", which flickers between two chips on a fast flick.
      const first = categories.find((category) => visible.has(category.id))
      if (first) setActive(first.id)
    }, { rootMargin: `-${CHIP_OFFSET_PX}px 0px -55% 0px` })

    for (const category of categories) {
      const section = document.getElementById(anchorId(category.id))
      if (section) observer.observe(section)
    }
    return () => observer.disconnect()
  }, [categories])

  return active
}

/**
 * Keeps the active chip on screen inside the rail. A menu with fifteen categories
 * has chips off both edges, and an active chip nobody can see is the same as no
 * chips at all.
 *
 * **It moves the rail's own `scrollLeft` and nothing else, because
 * `chip.scrollIntoView()` cannot be used here.** The obvious version —
 * `scrollIntoView({ inline: 'center', block: 'nearest' })` — was written first and
 * is broken in a way only a real browser shows: the chip lives inside a
 * `position: sticky` bar, and `scrollIntoView` aims at the element's *static* layout
 * position rather than the place it is painted while stuck. So every time the active
 * chip changed, the page smoothly scrolled itself back to where the rail statically
 * sits — about 170px down — and a customer scrolling through a long menu was thrown
 * back to the top of it every few seconds. `block: 'nearest'` does not save it: by
 * the element's static position it is genuinely off screen.
 *
 * The rects are measured rather than taken from `offsetLeft`, which is relative to
 * whichever ancestor happens to be positioned.
 *
 * It deliberately does nothing on the first run: the rail is already where it should
 * be, and moving it on mount is how a page ends up somewhere the customer did not
 * put it before they have touched anything.
 */
function useActiveChipInView(active: string | null) {
  const railRef = useRef<HTMLDivElement>(null)
  const mounted = useRef(false)

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true
      return
    }
    const rail = railRef.current
    const chip = rail?.querySelector(`[data-chip="${active}"]`)
    if (!rail || !(chip instanceof HTMLElement)) return
    const railBox = rail.getBoundingClientRect()
    const chipBox = chip.getBoundingClientRect()
    const centred = (chipBox.left - railBox.left) - (railBox.width - chipBox.width) / 2
    rail.scrollTo({ left: Math.max(0, rail.scrollLeft + centred), behavior: 'smooth' })
  }, [active])

  return railRef
}

// ---------------------------------------------------------------------------

/**
 * Fixed warm paper, not `prefers-color-scheme` — and for the same kind of reason the
 * kitchen board is fixed dark. A restaurant's menu is the restaurant's room; a page
 * that inverts itself because the phone changed its mind at dusk is a different
 * restaurant every evening. `color-scheme: light` is set with it so the radios and
 * checkboxes inside do not render dark on a phone in dark mode (the app's
 * `globals.css` puts `color-scheme: dark` on `html`).
 *
 * Phone first, and the two widenings are the only breakpoints: a row card up to
 * 600px because a list shows four dishes where a photo grid shows one and a half,
 * then a photo-led grid once there is room for one.
 */
const CSS = `
.ss {
  --paper: #fbf7f2;
  --card: #ffffff;
  --ink: #17120f;
  --ink-soft: #6a5f57;
  --line: #e7ded3;
  --accent: #a9271d;
  --accent-ink: #fff8f6;
  --diet-bg: #e9f4ec;
  --diet-ink: #1d6440;
  --allergen-bg: #fbeadb;
  --allergen-ink: #8a4a12;
  color-scheme: light;
  min-height: 100dvh;
  background: var(--paper);
  color: var(--ink);
  font-family: var(--font-geist-sans), system-ui, -apple-system, sans-serif;
  font-size: 16px;
  line-height: 1.4;
  padding-bottom: calc(96px + env(safe-area-inset-bottom));
}
.ss-head { padding: 14px 16px 10px; }
.ss-head-top { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
/*
  Clamped, and low, because the fold is the budget. A real client's name is
  "Kashi — Downtown Brooklyn", which at 30px is three lines of nothing but
  restaurant and pushes the first dish below the fold on a 390×844 phone — the one
  measurable thing the playbook says we beat the incumbents on.
*/
.ss-name {
  font-family: ui-serif, "Iowan Old Style", Palatino, Georgia, serif;
  font-size: clamp(21px, 6vw, 26px); line-height: 1.12; font-weight: 600; letter-spacing: -0.01em;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.ss-status {
  flex: none;
  font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
  padding: 5px 9px; border-radius: 999px;
  background: var(--diet-bg); color: var(--diet-ink);
}
.ss-status[data-open="false"] { background: #f4e7e5; color: var(--accent); }
.ss-meta { margin-top: 4px; font-size: 12.5px; color: var(--ink-soft); }
.ss-quiet { font-size: 12px; }
.ss-tel { text-decoration: underline; text-underline-offset: 2px; }
.ss-notice {
  margin-top: 8px; padding: 7px 10px; border-radius: 10px;
  background: #f4e7e5; color: var(--accent);
  font-size: 12.5px; font-weight: 600;
}

.ss-chips {
  position: sticky; top: 0; z-index: 30;
  background: color-mix(in oklab, var(--paper) 88%, transparent);
  backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--line);
}
.ss-rail {
  display: flex; gap: 7px; overflow-x: auto; scrollbar-width: none;
  padding: 9px 16px; scroll-padding-inline: 16px;
}
.ss-rail::-webkit-scrollbar { display: none; }
.ss-chip {
  flex: none; padding: 7px 13px; border-radius: 999px;
  border: 1px solid var(--line); background: var(--card);
  font-size: 14px; font-weight: 600; white-space: nowrap;
  transition: background 150ms ease, color 150ms ease, border-color 150ms ease;
}
.ss-chip[aria-current="page"] { background: var(--ink); color: var(--paper); border-color: var(--ink); }

.ss-main { padding: 4px 16px 24px; }
.ss-section { scroll-margin-top: ${CHIP_OFFSET_PX - 40}px; padding-top: 16px; }
.ss-cat {
  font-family: ui-serif, "Iowan Old Style", Palatino, Georgia, serif;
  font-size: 19px; font-weight: 600; margin-bottom: 9px;
}
.ss-grid { display: grid; grid-template-columns: 1fr; gap: 10px; }

.ss-card {
  position: relative;
  display: grid; grid-template-columns: 92px 1fr; gap: 12px; align-items: start;
  background: var(--card); border: 1px solid var(--line); border-radius: 15px;
  padding: 10px; overflow: hidden;
}
.ss-card[data-soldout="true"] { background: #f7f3ee; }
.ss-media {
  position: relative; width: 92px; aspect-ratio: 1; border-radius: 10px; overflow: hidden;
  background: #f2ece3;
}
.ss-card[data-soldout="true"] .ss-media { filter: grayscale(1); opacity: 0.55; }
.ss-photo { width: 100%; height: 100%; object-fit: cover; display: block; }
.ss-plate {
  position: absolute; inset: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;
  padding: 10px 8px; text-align: center;
  background: linear-gradient(170deg, #f6efe3, #efe6d7);
  box-shadow: inset 0 0 0 1px rgba(23,18,15,0.06);
}
.ss-plate-rule { display: block; width: 18px; height: 1px; background: rgba(23,18,15,0.22); }
.ss-plate-name {
  font-family: ui-serif, "Iowan Old Style", Palatino, Georgia, serif;
  font-size: 11.5px; line-height: 1.2; font-weight: 600; color: #4a3b2c;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
}
.ss-gone {
  position: absolute; inset-inline: 0; bottom: 0;
  background: rgba(23,18,15,0.82); color: #fff;
  font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
  padding: 4px 6px; text-align: center;
}
.ss-body { min-width: 0; padding-right: 32px; }
.ss-dish { font-size: 15.5px; font-weight: 650; line-height: 1.25; letter-spacing: -0.01em; }
.ss-desc {
  margin-top: 2px; font-size: 12.5px; line-height: 1.35; color: var(--ink-soft);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.ss-tags { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin-top: 6px; list-style: none; }
.ss-contains { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.ss-tag {
  font-size: 9.5px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase;
  padding: 2px 5px; border-radius: 4px; white-space: nowrap;
}
.ss-tag[data-tone="diet"] { background: var(--diet-bg); color: var(--diet-ink); }
.ss-tag[data-tone="allergen"] { background: var(--allergen-bg); color: var(--allergen-ink); }
.ss-tag-label { font-size: 9.5px; letter-spacing: 0.04em; color: var(--ink-soft); white-space: nowrap; }
.ss-price { margin-top: 6px; font-size: 14.5px; font-weight: 650; font-variant-numeric: tabular-nums; }
.ss-plus-note { margin-left: 2px; color: var(--ink-soft); font-weight: 500; }

.ss-hit {
  position: absolute; inset: 0; width: 100%; border: 0; background: transparent;
  cursor: pointer; padding: 0;
}
.ss-hit:disabled { cursor: default; }
.ss-add-dot {
  position: absolute; right: 10px; bottom: 10px;
  width: 29px; height: 29px; border-radius: 50%;
  display: grid; place-items: center;
  background: var(--accent); color: var(--accent-ink);
  font-size: 19px; line-height: 1; font-weight: 500;
  box-shadow: 0 1px 3px rgba(23,18,15,0.18);
  transition: transform 150ms ease;
}
.ss-hit:active .ss-add-dot { transform: scale(0.9); }
.ss-hit:disabled .ss-add-dot { display: none; }
.ss-hit:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; border-radius: 16px; }

/*
  A real <button> as of Task 3, not a div with a click handler: it opens a dialog,
  so it has to be reachable by keyboard and announce itself as a control. The
  font/border reset is what keeps it the same bar it was — a UA button otherwise
  shrinks the type and changes the height, and the height of this bar is part of the
  food-above-the-fold budget the page is measured on.
*/
.ss-bar {
  position: fixed; inset-inline: 0; bottom: 0; z-index: 40;
  display: flex; justify-content: space-between; align-items: center; gap: 12px;
  width: 100%; border: 0; text-align: left; cursor: pointer;
  padding: 14px 18px calc(14px + env(safe-area-inset-bottom));
  background: var(--ink); color: var(--paper);
  font: inherit; font-size: 15px; font-weight: 650;
}
.ss-bar-money { font-variant-numeric: tabular-nums; }
/* The affordance. Without it the bar states a number and looks like a status line,
   which is exactly what it was before there was anywhere for it to go. */
.ss-bar-cta {
  font-size: 13px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
  opacity: 0.85;
}
.ss-bar:focus-visible { outline: 2px solid var(--paper); outline-offset: -4px; }

.ss-sheet-wrap { position: fixed; inset: 0; z-index: 50; }
.ss-scrim { position: absolute; inset: 0; width: 100%; border: 0; background: rgba(23,18,15,0.5); }
.ss-sheet:focus { outline: none; }
.ss-sheet {
  position: absolute; inset-inline: 0; bottom: 0;
  display: flex; flex-direction: column; max-height: 92dvh;
  background: var(--paper); border-radius: 20px 20px 0 0;
  box-shadow: 0 -8px 40px rgba(23,18,15,0.28);
}
@media (prefers-reduced-motion: no-preference) {
  .ss-sheet { animation: ss-rise 260ms cubic-bezier(0.22, 1, 0.36, 1); }
  @keyframes ss-rise { from { transform: translateY(14px); opacity: 0.6; } to { transform: none; opacity: 1; } }
}
.ss-sheet-head {
  position: relative; display: grid; grid-template-columns: 84px 1fr; gap: 12px;
  padding: 18px 16px 14px; border-bottom: 1px solid var(--line);
}
.ss-sheet-media {
  position: relative; width: 84px; aspect-ratio: 1; border-radius: 11px; overflow: hidden; background: #f2ece3;
}
.ss-sheet-titles { min-width: 0; padding-right: 34px; }
.ss-sheet-name {
  font-family: ui-serif, "Iowan Old Style", Palatino, Georgia, serif;
  font-size: 21px; font-weight: 600;
}
.ss-sheet-desc { margin-top: 4px; font-size: 13px; color: var(--ink-soft); }
.ss-sheet-price { margin-top: 6px; font-size: 15px; font-weight: 650; font-variant-numeric: tabular-nums; }
.ss-close {
  position: absolute; top: 12px; right: 12px;
  width: 32px; height: 32px; border-radius: 50%;
  border: 1px solid var(--line); background: var(--card);
  font-size: 18px; line-height: 1; color: var(--ink-soft); cursor: pointer;
}
.ss-sheet-body { overflow-y: auto; padding: 4px 16px 16px; -webkit-overflow-scrolling: touch; }
.ss-group { border: 0; padding: 14px 0 4px; border-bottom: 1px solid var(--line); }
.ss-legend { display: flex; align-items: baseline; gap: 8px; padding: 0 0 4px; }
.ss-group-name { font-size: 15px; font-weight: 650; }
.ss-group-hint { font-size: 11px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: var(--ink-soft); }
.ss-option {
  display: flex; align-items: center; gap: 10px;
  min-height: 48px; font-size: 15px; cursor: pointer;
}
.ss-option input { width: 20px; height: 20px; accent-color: var(--accent); flex: none; }
.ss-option[data-off="true"] { color: var(--ink-soft); cursor: default; }
.ss-option-name { flex: 1; min-width: 0; }
.ss-option-off { font-size: 11px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; }
.ss-option-price { font-variant-numeric: tabular-nums; color: var(--ink-soft); }
.ss-note { display: block; padding: 16px 0 4px; }
.ss-note-label { display: block; font-size: 15px; font-weight: 650; margin-bottom: 7px; }
.ss-note-input {
  width: 100%; resize: vertical; font: inherit; font-size: 15px; color: inherit;
  padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--card);
}
.ss-note-count { display: block; margin-top: 5px; font-size: 11px; color: var(--ink-soft); text-align: right; }
.ss-sheet-foot {
  display: flex; align-items: center; gap: 12px;
  padding: 12px 16px calc(12px + env(safe-area-inset-bottom));
  border-top: 1px solid var(--line); background: var(--paper);
}
.ss-stepper {
  display: flex; align-items: center; flex: none;
  border: 1px solid var(--line); border-radius: 12px; background: var(--card);
}
.ss-stepper button {
  width: 44px; height: 48px; border: 0; background: transparent;
  font-size: 20px; line-height: 1; color: var(--ink); cursor: pointer;
}
.ss-stepper button:disabled { color: #c9bfb4; cursor: default; }
.ss-qty { min-width: 22px; text-align: center; font-size: 16px; font-weight: 650; font-variant-numeric: tabular-nums; }
.ss-add {
  flex: 1; min-height: 52px; border: 0; border-radius: 12px;
  background: var(--accent); color: var(--accent-ink);
  font: inherit; font-size: 16px; font-weight: 700; cursor: pointer;
}
.ss-add:disabled { background: #e7ded3; color: #8a7f74; cursor: default; }

@media (min-width: 600px) {
  .ss-grid { grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 18px; }
  .ss-card { grid-template-columns: 1fr; gap: 0; padding: 0; }
  .ss-media { width: 100%; aspect-ratio: 4 / 3; border-radius: 0; }
  .ss-card[data-photo="false"] .ss-media { aspect-ratio: 16 / 7; }
  .ss-plate-name { font-size: 18px; -webkit-line-clamp: 2; }
  .ss-plate-rule { width: 26px; }
  .ss-body { padding: 14px 14px 16px; }
  .ss-add-dot { right: 14px; bottom: 14px; width: 34px; height: 34px; font-size: 21px; }
  .ss-head, .ss-main, .ss-rail { max-width: 1040px; margin-inline: auto; }
  .ss-name { font-size: 36px; }
  .ss-sheet {
    inset: 0; margin: auto; width: min(560px, calc(100% - 48px)); height: max-content;
    max-height: 86dvh; border-radius: 18px;
  }
  .ss-bar { justify-content: center; gap: 24px; }
}
`
