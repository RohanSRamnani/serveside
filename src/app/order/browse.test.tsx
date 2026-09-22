import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { eq } from 'drizzle-orm'
import { menuItems } from '@/db/schema'
import type { SnapshotCategory, SnapshotItem, SnapshotModifierGroup } from '@/db/schema'
import { withLocation } from '@/repo/scoped'
import { buildMenuSnapshot } from '@/domain/snapshot'
import type { StorefrontView } from '@/domain/storefront'
import { seedLocation, seedLocationWithMenu, seedBusinessHours } from '@/test/seed'
import OrderPage from './[location]/page'
import { cartSubtotalCents, cartTotals } from '@/lib/cart'
import { formatCents } from '@/lib/money'
import { MAX_TEXT_FIELD_LENGTH } from '@/lib/order-limits'
import Browse, {
  DishSheetView, addBlockedReason, addLabel, anchorId, closedNotice,
  dishUnitPriceCents, formatPhone, formatServiceWindows, selectionHint, soldOut, tagPills,
  toggleOption,
} from './[location]/browse'
import { CartDrawerView } from './[location]/cart-drawer'
import {
  addToLines, parseStoredLines, removeAt, sameLine, setLineQty, shouldPersist, storageKey,
  type CartLine,
} from './[location]/cart-provider'

/**
 * The first thing a hungry person on a phone ever sees of this product.
 *
 * Split the way `feed-client.test.tsx` is split, and for the same reason: the
 * decisions a dish sheet makes — is this addable, what does it cost with these
 * modifiers on it, which tag is an allergen — are ordinary functions and are tested
 * as such, while everything that has to *appear* is rendered to static markup. There
 * is no jsdom in this suite, so a tap cannot be simulated; the sheet is therefore
 * split into a stateful `DishSheet` and a fully-controlled `DishSheetView`, and it is
 * the view that is rendered here with each selection state a customer can be in.
 *
 * **What this does not cover, and what does:** the sticky chips tracking scroll
 * position, the bottom sheet's gesture, and `localStorage` surviving a reload. None
 * of those exist outside a browser. They are the visual check — `/order/kashi` at
 * 390px on a real dev server.
 */

// ---------------------------------------------------------------------------
// Fixtures. Shaped like a snapshot payload because that is the only thing browse
// is ever handed — see `storefrontView`.
// ---------------------------------------------------------------------------

const SPICE: SnapshotModifierGroup = {
  id: 'grp-spice',
  name: 'Spice Level',
  // The Task 4 Plan-1 ruling: `minSelect` decides mandatoriness, `required` is
  // display intent. Both agree here; a case below has them disagree on purpose.
  minSelect: 1,
  maxSelect: 1,
  required: true,
  options: [
    { id: 'opt-mild', name: 'Mild', priceDeltaCents: 0, is86d: false },
    { id: 'opt-hot', name: 'Hot', priceDeltaCents: 50, is86d: false },
    { id: 'opt-extra', name: 'Extra hot', priceDeltaCents: 100, is86d: true },
  ],
}

const SIDES: SnapshotModifierGroup = {
  id: 'grp-sides',
  name: 'Add a side',
  minSelect: 0,
  maxSelect: 2,
  required: false,
  options: [
    { id: 'opt-naan', name: 'Garlic naan', priceDeltaCents: 450, is86d: false },
    { id: 'opt-raita', name: 'Raita', priceDeltaCents: 300, is86d: false },
    { id: 'opt-papad', name: 'Papad', priceDeltaCents: 150, is86d: false },
  ],
}

function item(over: Partial<SnapshotItem> = {}): SnapshotItem {
  return {
    id: 'itm-butter-chicken',
    name: 'Butter Chicken',
    basePriceCents: 1800,
    is86d: false,
    description: 'Tandoori chicken tikka in a creamy tomato gravy.',
    photoUrl: null,
    tags: ['Dairy', 'Tree Nuts'],
    modifierGroups: [SPICE],
    ...over,
  }
}

function view(over: Partial<StorefrontView> = {}): StorefrontView {
  const categories: SnapshotCategory[] = [
    { id: 'cat-starters', name: 'Starters', items: [item({ id: 'itm-gobi', name: 'Chilli Gobi', basePriceCents: 1400, modifierGroups: [] })] },
    { id: 'cat-mains', name: 'Mains', items: [item()] },
    { id: 'cat-breads', name: 'Breads', items: [item({ id: 'itm-naan', name: 'Garlic Naan', basePriceCents: 500, modifierGroups: [] })] },
  ]
  return {
    location: {
      name: 'Kashi',
      slug: 'kashi',
      timezone: 'America/New_York',
      phoneE164: '+19735550123',
      address: '123 Livingston Ave, Livingston NJ',
      prepTimeMinutes: 20,
      taxRatePer100k: 8875,
    },
    open: { open: true },
    snapshotVersion: 7,
    categories,
    ...over,
  }
}

const LUNCH_AND_DINNER = [
  { openTime: '11:30:00', closeTime: '15:00:00' },
  { openTime: '17:00:00', closeTime: '22:00:00' },
]

function browse(over: Partial<StorefrontView> = {}, todayHours = LUNCH_AND_DINNER): string {
  return renderToStaticMarkup(<Browse view={view(over)} todayHours={todayHours} />)
}

/** Where `needle` first appears, so two things can be asserted to be in an order. */
function at(markup: string, needle: string): number {
  const ix = markup.indexOf(needle)
  expect(ix, `${JSON.stringify(needle)} is not in the markup at all`).toBeGreaterThan(-1)
  return ix
}

/**
 * The whole `<input>` tag for one modifier option, so a test can ask what is on it
 * without depending on the order React chooses to write attributes in — it puts
 * `disabled` before `value`, and that is React's business rather than a fact worth
 * pinning here.
 */
function inputFor(markup: string, optionId: string): string {
  const found = markup.match(new RegExp(`<input[^>]*value="${optionId}"[^>]*>`))
  expect(found, `no <input> for option ${optionId}`).not.toBeNull()
  return found![0]
}

// ---------------------------------------------------------------------------

describe('the menu a phone is handed', () => {
  it('renders the categories in the snapshot’s own order, chips and sections alike', () => {
    // The snapshot's order is the restaurant's order — `sort` on the category rows,
    // resolved when the menu was pinned. Re-sorting here (alphabetically, by price,
    // by anything) would put breads before mains on a menu the owner laid out.
    const markup = browse()
    expect(at(markup, 'Starters')).toBeLessThan(at(markup, 'Mains'))
    expect(at(markup, 'Mains')).toBeLessThan(at(markup, 'Breads'))
    // Chips before dishes: they are the whole point of not making anyone scroll.
    expect(at(markup, `#${anchorId('cat-breads')}`)).toBeLessThan(at(markup, 'Chilli Gobi'))
  })

  it('gives every chip an anchor that lands on its own section', () => {
    const markup = browse()
    for (const id of ['cat-starters', 'cat-mains', 'cat-breads']) {
      expect(markup).toContain(`href="#${anchorId(id)}"`)
      expect(markup).toContain(`id="${anchorId(id)}"`)
    }
  })

  it('prints what a customer decides on: the dish, its own words, and the price', () => {
    const markup = browse()
    expect(markup).toContain('Butter Chicken')
    expect(markup).toContain('Tandoori chicken tikka in a creamy tomato gravy.')
    expect(markup).toContain('$18.00')
  })

  it('renders dietary and allergen tags as pills on the dish, never as fine print', () => {
    const markup = browse()
    // The pills are marked in the markup so this asserts a pill and not merely the
    // word appearing somewhere on the page.
    expect(markup).toContain('data-tag="Dairy"')
    expect(markup).toContain('data-tag="Tree Nuts"')
    // An allergen pill has to read as one. The restaurant's own word is kept
    // verbatim — "Dairy", not a rewording — and the pill says what it means.
    expect(markup).toMatch(/data-tone="allergen"[^>]*data-tag="Dairy"|data-tag="Dairy"[^>]*data-tone="allergen"/)
    expect(markup).toContain('contains')
  })

  it('draws the typographic plate when a dish has no photo, and it carries the dish', () => {
    // restaurant-playbook: a missing photo must read as restraint, never as a bug.
    // So the test is not "there is a box" — it is that the plate says something.
    const markup = browse()
    expect(markup).toContain('data-plate="typographic"')
    expect(markup).not.toContain('<img')
  })

  it('uses the photo when the snapshot pinned one', () => {
    const withPhoto = view()
    withPhoto.categories[1].items[0] = item({ photoUrl: 'https://cdn.example/kashi/butter-chicken.jpg' })
    const markup = renderToStaticMarkup(<Browse view={withPhoto} todayHours={LUNCH_AND_DINNER} />)
    expect(markup).toContain('src="https://cdn.example/kashi/butter-chicken.jpg"')
    expect(markup).toContain('alt="Butter Chicken"')
  })

  it('keeps a sold-out dish on the menu, marked, and refuses to let it be added', () => {
    // Hiding it makes the menu look thinner than the restaurant is, and a customer
    // who cannot find the dish they came for assumes it was never sold.
    const markup = browse({
      categories: view().categories.map((cat) => (cat.id === 'cat-mains'
        ? { ...cat, items: [item({ is86d: true })] }
        : cat)),
    })
    expect(markup).toContain('Butter Chicken')
    expect(markup).toContain('Sold out today')
    // The card's own control is disabled — not merely styled grey.
    expect(markup).toMatch(/<button[^>]*data-item="itm-butter-chicken"[^>]*disabled/)
  })

  it('renders a snapshot pinned before dish cards had fields to pin', () => {
    // `description`, `photoUrl` and `tags` are optional because `menu_snapshots` is
    // immutable: rows written before 2026-09-22 will never grow them. A reader that
    // did `item.tags.map(…)` would throw on a six-month-old menu.
    const old: SnapshotItem = {
      id: 'itm-old', name: 'Lamb Rogan Josh', basePriceCents: 2100, is86d: false, modifierGroups: [],
    }
    const markup = browse({ categories: [{ id: 'cat-mains', name: 'Mains', items: [old] }] })
    expect(markup).toContain('Lamb Rogan Josh')
    expect(markup).toContain('$21.00')
  })

  it('says it is open, with today’s hours, when it is', () => {
    const markup = browse()
    expect(markup).toContain('Open')
    expect(markup).toContain('11:30 AM')
    expect(markup).toContain('10:00 PM')
    // The pickup quote is the live one from the location row.
    expect(markup).toContain('20 min')
  })

  it('tells a customer why it is shut, in words rather than a reason code', () => {
    const paused = browse({ open: { open: false, reason: 'paused' } })
    expect(paused).not.toContain('closed_hours')
    expect(paused).not.toContain('paused')
    expect(paused.toLowerCase()).toContain('not taking orders')

    const shut = browse({ open: { open: false, reason: 'closed_hours' } })
    expect(shut.toLowerCase()).toContain('closed')
    // And the hours, because "closed" without them is a dead end.
    expect(shut).toContain('11:30 AM')
  })

  it('shows the restaurant’s phone number, which is what a customer taps when something is wrong', () => {
    const markup = browse()
    // Readable in the label, E.164 in the href — the format that actually dials.
    expect(markup).toContain('(973) 555-0123')
    expect(markup).toContain('href="tel:+19735550123"')
  })
})

describe('the dish sheet', () => {
  function sheet(over: Partial<Parameters<typeof DishSheetView>[0]> = {}): string {
    return renderToStaticMarkup(
      <DishSheetView
        item={item({ modifierGroups: [SPICE, SIDES] })}
        selected={[]}
        qty={1}
        notes=""
        onToggle={() => {}}
        onQty={() => {}}
        onNotes={() => {}}
        onAdd={() => {}}
        onClose={() => {}}
        {...over}
      />,
    )
  }

  it('blocks Add until a mandatory group has been answered, and says which one', () => {
    const markup = sheet()
    expect(markup).toMatch(/<button[^>]*data-add="1"[^>]*disabled/)
    expect(markup).toContain('Spice Level — choose 1')
  })

  it('lets the dish be added once the choice is made, priced with the delta on it', () => {
    const markup = sheet({ selected: ['opt-hot'] })
    expect(markup).not.toMatch(/<button[^>]*data-add="1"[^>]*disabled/)
    // 1800 + 50.
    expect(markup).toContain('Add — $18.50')
    expect(markup).not.toContain('Spice Level — choose 1')
  })

  it('multiplies the whole line, modifiers included, by the quantity', () => {
    // (1800 + 50 + 450) × 2. A qty stepper that multiplied only the base price is a
    // silent undercharge, and the customer would see the wrong number first.
    expect(sheet({ selected: ['opt-hot', 'opt-naan'], qty: 2 })).toContain('Add — $46.00')
  })

  it('says how many choices a group takes, in a customer’s words', () => {
    const markup = sheet()
    expect(markup).toContain('Choose 1')
    expect(markup).toContain('Choose up to 2')
  })

  it('keeps a sold-out option visible and unpickable', () => {
    const markup = sheet()
    expect(markup).toContain('Extra hot')
    expect(inputFor(markup, 'opt-extra')).toContain('disabled')
    expect(inputFor(markup, 'opt-mild')).not.toContain('disabled')
  })

  it('closes a multi-choice group once it is full, and leaves the ticked ones tickable', () => {
    // The server enforces the same maximum, so a third side would come back a named
    // rejection. Disabling the unticked ones says why before that happens.
    const markup = sheet({ selected: ['opt-hot', 'opt-naan', 'opt-raita'] })
    expect(inputFor(markup, 'opt-papad')).toContain('disabled')
    expect(inputFor(markup, 'opt-naan')).not.toContain('disabled')
  })

  it('caps the note at exactly what the order path will accept', () => {
    // The textarea and `assertInputShape` now read the same constant out of
    // `@/lib/order-limits`, so "exactly" is true by construction rather than by two
    // files happening to agree. The literal is pinned here because the number
    // reaching the markup is the thing a customer meets: a textarea that let 600
    // through would turn their allergy note into a rejected order.
    expect(MAX_TEXT_FIELD_LENGTH).toBe(500)
    expect(sheet()).toMatch(/<textarea[^>]*maxlength="500"/i)
  })

  it('prices a dish with no modifiers at all', () => {
    expect(sheet({ item: item({ modifierGroups: [] }) })).toContain('Add — $18.00')
  })
})

describe('the decisions a sheet makes', () => {
  it('replaces the choice in a single-choice group and toggles in a multi', () => {
    expect(toggleOption(SPICE, ['opt-mild'], 'opt-hot')).toEqual(['opt-hot'])
    expect(toggleOption(SPICE, ['opt-hot'], 'opt-hot')).toEqual([])
    expect(toggleOption(SIDES, ['opt-naan'], 'opt-raita')).toEqual(['opt-naan', 'opt-raita'])
    expect(toggleOption(SIDES, ['opt-naan', 'opt-raita'], 'opt-naan')).toEqual(['opt-raita'])
  })

  it('refuses a choice past the group’s maximum rather than silently dropping another', () => {
    // maxSelect is pinned per item and the server re-enforces it, so a UI that let a
    // third side through would produce an order the server rejects by name.
    expect(toggleOption(SIDES, ['opt-naan', 'opt-raita'], 'opt-papad'))
      .toEqual(['opt-naan', 'opt-raita'])
  })

  it('blocks a sold-out dish, whatever else is chosen on it', () => {
    expect(addBlockedReason(item({ is86d: true }), ['opt-hot'])).toBe('Sold out today')
  })

  it('calls a dish sold out when the group it needs has nothing left', () => {
    // Friday night: both spice levels ran out. The dish is not 86'd, and it is
    // unorderable anyway — a card that invited a tap here would open a sheet whose
    // Add button can never be reached.
    const nothingLeft: SnapshotModifierGroup = {
      ...SPICE, options: SPICE.options.map((option) => ({ ...option, is86d: true })),
    }
    expect(soldOut(item({ modifierGroups: [nothingLeft] }))).toBe(true)
    expect(addBlockedReason(item({ modifierGroups: [nothingLeft] }), [])).toBe('Sold out today')
    // An *optional* group running dry does not take the dish down with it.
    const optionalDry: SnapshotModifierGroup = {
      ...SIDES, options: SIDES.options.map((option) => ({ ...option, is86d: true })),
    }
    expect(soldOut(item({ modifierGroups: [optionalDry] }))).toBe(false)
  })

  it('blocks on minSelect, and never on `required`', () => {
    // The ruling: a payload may legitimately say `required: true, minSelect: 0` — an
    // item that opted out of a normally-mandatory group. `required` is display intent.
    const optedOut: SnapshotModifierGroup = { ...SPICE, minSelect: 0, required: true }
    expect(addBlockedReason(item({ modifierGroups: [optedOut] }), [])).toBeNull()
    expect(addBlockedReason(item({ modifierGroups: [SPICE] }), [])).toBe('Spice Level — choose 1')
    expect(addBlockedReason(item({ modifierGroups: [SPICE] }), ['opt-mild'])).toBeNull()
  })

  it('names the first unanswered group, so a customer is told one thing to do', () => {
    const twoMandatory = item({ modifierGroups: [SPICE, { ...SIDES, minSelect: 1 }] })
    expect(addBlockedReason(twoMandatory, [])).toBe('Spice Level — choose 1')
    expect(addBlockedReason(twoMandatory, ['opt-hot'])).toBe('Add a side — choose 1')
  })

  it('wears the group’s name as a label, so every shape a restaurant writes reads as English', () => {
    // We do not write these names — Kashi's come verbatim from their published
    // ordering data — and this string is the primary button on the dish sheet. An
    // earlier version slotted the name into a sentence (`Choose a ${name}`), which
    // reads only for a bare noun: the imperative names below produced "Choose an Add
    // Rice", "Choose a Select a Side" and "Choose a Choose Spice Level".
    const blocked = (name: string, minSelect = 1) => addBlockedReason(
      item({ modifierGroups: [{ ...SPICE, name, minSelect }] }),
      [],
    )
    expect(blocked('Spice Level')).toBe('Spice Level — choose 1')
    expect(blocked('Add Rice')).toBe('Add Rice — choose 1')
    expect(blocked('Select a Side')).toBe('Select a Side — choose 1')
    expect(blocked('Choose Spice Level')).toBe('Choose Spice Level — choose 1')
    // No article is ever prepended, whatever letter the name starts with.
    for (const name of ['Spice Level', 'Add Rice', 'Select a Side', 'Extras']) {
      expect(blocked(name), name).not.toMatch(/\bChoose an? [A-Z]/)
    }
  })

  it('counts what is still owed, not the group’s total', () => {
    // A group that takes two, with one already picked. "choose 2" there reads as
    // though the first pick did not register.
    const pickTwo = item({ modifierGroups: [{ ...SIDES, name: 'Toppings', minSelect: 2 }] })
    expect(addBlockedReason(pickTwo, [])).toBe('Toppings — choose 2')
    expect(addBlockedReason(pickTwo, ['opt-naan'])).toBe('Toppings — choose 1 more')
    expect(addBlockedReason(pickTwo, ['opt-naan', 'opt-raita'])).toBeNull()
  })

  it('adds every chosen delta to the base price, including a negative one', () => {
    expect(dishUnitPriceCents(item(), [])).toBe(1800)
    expect(dishUnitPriceCents(item({ modifierGroups: [SPICE, SIDES] }), ['opt-hot', 'opt-naan'])).toBe(2300)
    const sizeDown: SnapshotModifierGroup = {
      ...SIDES, options: [{ id: 'opt-small', name: 'Small', priceDeltaCents: -200, is86d: false }],
    }
    expect(dishUnitPriceCents(item({ modifierGroups: [sizeDown] }), ['opt-small'])).toBe(1600)
  })

  it('ignores an id that is not on this dish rather than pricing it', () => {
    // Belt and braces: the sheet can only produce its own ids, and a stale one from
    // `localStorage` must not become a price.
    expect(dishUnitPriceCents(item(), ['opt-from-another-dish'])).toBe(1800)
  })

  it('writes the price on the button the way a receipt would', () => {
    expect(addLabel(1850, 1)).toBe('Add — $18.50')
    expect(addLabel(1850, 3)).toBe('Add — $55.50')
  })

  it('describes a group’s limits without saying “minSelect”', () => {
    expect(selectionHint(SPICE)).toBe('Choose 1')
    expect(selectionHint(SIDES)).toBe('Choose up to 2')
    expect(selectionHint({ ...SIDES, minSelect: 2, maxSelect: 2 })).toBe('Choose 2')
    expect(selectionHint({ ...SIDES, minSelect: 1, maxSelect: 3 })).toBe('Choose 1 to 3')
    // One thing, or nothing: "choose up to 1" is not English.
    expect(selectionHint({ ...SIDES, minSelect: 0, maxSelect: 1 })).toBe('Optional')
  })

  it('tells an allergen from a diet, and does not read “gluten free” as gluten', () => {
    expect(tagPills(['Vegetarian', 'Dairy'])).toEqual([
      { label: 'Vegetarian', tone: 'diet' },
      { label: 'Dairy', tone: 'allergen' },
    ])
    // The trap: substring matching would flag the one tag that means the opposite.
    expect(tagPills(['Gluten Free'])).toEqual([{ label: 'Gluten Free', tone: 'diet' }])
    expect(tagPills(['Tree Nuts', 'Sesame', 'Shellfish'])).toEqual([
      { label: 'Tree Nuts', tone: 'allergen' },
      { label: 'Sesame', tone: 'allergen' },
      { label: 'Shellfish', tone: 'allergen' },
    ])
    // Absent, not empty: a pre-2026-09-22 snapshot has no `tags` key at all.
    expect(tagPills(undefined)).toEqual([])
  })

  it('prints a US phone number the way a customer reads one, and anything else verbatim', () => {
    expect(formatPhone('+19735550123')).toBe('(973) 555-0123')
    // Not ours to reformat: a "clever" rule applied to a +44 number garbles it.
    expect(formatPhone('+442071234567')).toBe('+442071234567')
    expect(formatPhone('+1973555012')).toBe('+1973555012')
  })

  it('renders today’s hours as a customer reads a door', () => {
    expect(formatServiceWindows(LUNCH_AND_DINNER)).toBe('11:30 AM – 3:00 PM, 5:00 PM – 10:00 PM')
    expect(formatServiceWindows([{ openTime: '11:00:00', closeTime: '22:00:00' }])).toBe('11:00 AM – 10:00 PM')
    // `24:00:00` is a legal Postgres `time` and the whole-day grid is what the dev
    // seed posts; "midnight – midnight" is not a sentence.
    expect(formatServiceWindows([{ openTime: '00:00:00', closeTime: '24:00:00' }])).toBe('Open 24 hours')
    expect(formatServiceWindows([])).toBe('Closed today')
  })

  it('turns each closed reason into the sentence it actually means', () => {
    // "Try again in an hour" and "come back tomorrow" are different sentences, and
    // `isOpenAt` already tells them apart — losing the distinction here throws away
    // the one piece of information the customer can act on.
    expect(closedNotice({ open: true }, LUNCH_AND_DINNER)).toBeNull()
    expect(closedNotice({ open: false, reason: 'paused' }, LUNCH_AND_DINNER))
      .toMatch(/not taking orders/i)
    expect(closedNotice({ open: false, reason: 'holiday' }, [])).toMatch(/closed today/i)
    expect(closedNotice({ open: false, reason: 'closed_hours' }, LUNCH_AND_DINNER))
      .toMatch(/11:30 AM/)
  })
})

describe('the cart the dish sheet fills', () => {
  function line(over: Partial<CartLine> = {}): CartLine {
    return {
      menuItemId: 'itm-butter-chicken',
      name: 'Butter Chicken',
      unitPriceCents: 1850,
      qty: 1,
      modifierOptionIds: ['opt-hot'],
      modifierNames: ['Hot'],
      modifierDeltaCents: 50,
      ...over,
    }
  }

  it('bumps the quantity when the same dish is added the same way twice', () => {
    const lines = addToLines(addToLines([], line()), line())
    expect(lines).toHaveLength(1)
    expect(lines[0].qty).toBe(2)
  })

  it('keeps the same dish as two lines when it was ordered two different ways', () => {
    // One mild and one hot is two dishes to a kitchen. Merging them would print one
    // ticket line and somebody would get the wrong dinner.
    const lines = addToLines(addToLines([], line()), line({
      unitPriceCents: 1800, modifierOptionIds: ['opt-mild'], modifierNames: ['Mild'], modifierDeltaCents: 0,
    }))
    expect(lines).toHaveLength(2)
  })

  it('treats a note as part of what makes a line its own line', () => {
    const lines = addToLines(addToLines([], line()), line({ notes: 'no cilantro' }))
    expect(lines).toHaveLength(2)
    expect(sameLine(line(), line({ notes: 'no cilantro' }))).toBe(false)
    expect(sameLine(line(), line({ qty: 9 }))).toBe(true)
  })

  it('does not care what order the modifiers were ticked in', () => {
    const naanFirst = line({ modifierOptionIds: ['opt-naan', 'opt-hot'] })
    expect(sameLine(line({ modifierOptionIds: ['opt-hot', 'opt-naan'] }), naanFirst)).toBe(true)
  })

  it('removes the line when its quantity is stepped down to nothing', () => {
    expect(setLineQty([line()], 0, 0)).toEqual([])
    expect(setLineQty([line()], 0, 3)[0].qty).toBe(3)
    // A stepper that could go negative would produce a negative subtotal.
    expect(setLineQty([line()], 0, -1)).toEqual([])
  })

  it('removes by position, and leaves the rest where they were', () => {
    const two = [line(), line({ menuItemId: 'itm-naan', name: 'Garlic Naan' })]
    expect(removeAt(two, 0).map((l) => l.name)).toEqual(['Garlic Naan'])
    expect(removeAt(two, 7)).toEqual(two)
  })

  it('adds the lines up with the same money helpers the server prices with', () => {
    // `cartSubtotalCents` lives in `@/lib/cart` as of Task 3, so the bottom bar's
    // number and the drawer's totals are one computation rather than two.
    expect(cartSubtotalCents([line({ qty: 2 }), line({ unitPriceCents: 500, qty: 1 })])).toBe(4200)
    expect(cartSubtotalCents([])).toBe(0)
  })

  it('keeps one restaurant’s cart out of another’s', () => {
    expect(storageKey('kashi')).not.toBe(storageKey('marigold'))
    expect(storageKey('kashi')).toContain('kashi')
  })

  it('throws away a stored cart it cannot vouch for, rather than rendering it', () => {
    // Whatever is in `localStorage` was written by a version of this page that no
    // longer exists, by another tab, or by hand. A line with a string price would
    // put "$NaN" on a customer's screen.
    expect(parseStoredLines(null)).toEqual([])
    expect(parseStoredLines('not json')).toEqual([])
    expect(parseStoredLines('{}')).toEqual([])
    expect(parseStoredLines(JSON.stringify({ v: 1, lines: [{ ...line(), unitPriceCents: '18.50' }] }))).toEqual([])
    expect(parseStoredLines(JSON.stringify({ v: 1, lines: [{ ...line(), qty: 0 }] }))).toEqual([])
    expect(parseStoredLines(JSON.stringify({ v: 99, lines: [line()] }))).toEqual([])
  })

  it('reads back a cart it wrote itself', () => {
    const lines = [line({ qty: 2, notes: 'extra crispy' })]
    expect(parseStoredLines(JSON.stringify({ v: 1, lines }))).toEqual(lines)
  })

  it('never writes an empty cart it has not read yet over the stored one', () => {
    // The regression this is here for: the save effect ran on mount, saw a `loaded`
    // ref the read effect had just set, and wrote the first render's empty `lines`
    // over the stored cart — so every reload came back empty. A ref cannot tell
    // "not read yet" from "read, and genuinely empty"; pairing the lines with the
    // slug they were read for can, and that decision is this function.
    expect(shouldPersist({ slug: null, lines: [] }, 'kashi')).toBe(false)
    expect(shouldPersist({ slug: 'kashi', lines: [line()] }, 'kashi')).toBe(true)
  })

  it('writes an emptied cart, because a cleared cart is a cart', () => {
    // The other half of the same distinction, and the one a `loaded` ref got wrong
    // in the opposite direction: removing the last line must reach storage, or a
    // reload brings back the dinner the customer just deleted.
    expect(shouldPersist({ slug: 'kashi', lines: [] }, 'kashi')).toBe(true)
  })

  it('does not write one restaurant’s cart under another’s key', () => {
    // A slug the store was not read for is a store from the page before it. One
    // origin serves every storefront, so writing it here would hand the customer
    // another restaurant's dishes, priced from another restaurant's menu.
    expect(shouldPersist({ slug: 'kashi', lines: [line()] }, 'marigold')).toBe(false)
  })
})

describe('the cart drawer', () => {
  function line(over: Partial<CartLine> = {}): CartLine {
    return {
      menuItemId: 'itm-butter-chicken',
      name: 'Butter Chicken',
      unitPriceCents: 2000,
      qty: 1,
      modifierOptionIds: ['opt-hot'],
      modifierNames: ['Hot'],
      modifierDeltaCents: 200,
      ...over,
    }
  }

  function drawer(over: Partial<Parameters<typeof CartDrawerView>[0]> = {}): string {
    return renderToStaticMarkup(
      <CartDrawerView
        lines={[line({ qty: 2 })]}
        taxRatePer100k={8875}
        closedReason={null}
        onQty={() => {}}
        onRemove={() => {}}
        onCheckout={() => {}}
        onClose={() => {}}
        {...over}
      />,
    )
  }

  it('shows every line, what was chosen on it, and what it comes to', () => {
    const markup = drawer({
      lines: [line({ qty: 2, modifierNames: ['Hot', 'Garlic naan'], notes: 'no cilantro' })],
    })
    expect(markup).toContain('Butter Chicken')
    expect(markup).toContain('Hot')
    expect(markup).toContain('Garlic naan')
    expect(markup).toContain('no cilantro')
    // 2 × $20.00. The line total, not the unit price: it is the number being
    // committed to, the same way the Add button carries the line rather than the dish.
    expect(markup).toContain('$40.00')
  })

  it('breaks the money out, and says the total is an estimate', () => {
    // The labels are the whole reason a display-only total is honest. `cartTotals`
    // is pre-tip and the server recomputes the charge, so a bare "Total" here would
    // be a promise this page cannot keep.
    const markup = drawer()
    expect(markup).toContain('Subtotal')
    expect(markup).toContain('$40.00')
    expect(markup).toContain('Tax')
    expect(markup).toContain('$3.55')
    expect(markup).toContain('$43.55')
    expect(markup).toContain('estimated — confirmed at payment')
  })

  it('lets a customer check out when the restaurant is open', () => {
    expect(checkoutButton(drawer())).not.toContain('disabled')
  })

  it('refuses checkout when the kitchen is shut, in the words the header already used', () => {
    // The reason is `closedNotice`'s, handed down — not a second copy of the
    // wording. Two sentences for the same fact drift, and the one that drifts is
    // always the one nobody reads.
    const reason = closedNotice({ open: false, reason: 'paused' }, LUNCH_AND_DINNER)
    const markup = drawer({ closedReason: reason })
    expect(checkoutButton(markup)).toContain('disabled')
    expect(markup).toContain('Not taking orders right now')
  })

  it('turns the last line’s minus into a remove, so a stepper can empty a line', () => {
    // At one, stepping down means "take it off the order" — `setLineQty` already
    // removes at zero, and a disabled minus would leave no way out of a line but a
    // second control nobody looks for.
    expect(drawer({ lines: [line({ qty: 1 })] })).toContain('Remove Butter Chicken')
    expect(drawer({ lines: [line({ qty: 2 })] })).toContain('One fewer Butter Chicken')
  })

  it('says the cart is empty rather than showing $0.00 three times', () => {
    const markup = drawer({ lines: [] })
    expect(markup).toMatch(/nothing in your order/i)
    expect(markup).not.toContain('estimated — confirmed at payment')
  })

  it('prices the drawer with the same helpers as everything else', () => {
    // Not a second arithmetic path: whatever `cartTotals` says is what is rendered.
    const lines = [line({ qty: 2 }), line({ unitPriceCents: 450, qty: 3 })]
    const totals = cartTotals(lines, 8875)
    const markup = drawer({ lines })
    expect(markup).toContain(`$${formatCents(totals.totalCents)}`)
    expect(markup).toContain(`$${formatCents(totals.taxCents)}`)
  })
})

/** The Checkout button's own tag, so "disabled" is read off it and not off the drawer. */
function checkoutButton(markup: string): string {
  const match = /<button[^>]*data-checkout="1"[^>]*>/.exec(markup)
  if (!match) throw new Error('no checkout button in the drawer')
  return match[0]
}

describe('/order/[location]', () => {
  function render(slug: string): Promise<string> {
    return OrderPage({
      params: Promise.resolve({ location: slug }),
      searchParams: Promise.resolve({}),
    }).then(renderToStaticMarkup)
  }

  /** A restaurant a customer could actually order from: hours posted, menu pinned. */
  async function storefront() {
    const loc = await seedLocationWithMenu()
    await seedBusinessHours(loc.id)
    await buildMenuSnapshot(loc.id)
    return loc
  }

  it('paints the pinned menu on the server, resolved by the public slug', async () => {
    const loc = await storefront()
    const markup = await render(loc.storefrontSlug)
    expect(markup).toContain(loc.name)
    expect(markup).toContain('Butter Chicken')
    expect(markup).toContain('Tomato, cream, fenugreek.')
    expect(markup).toContain('$18.00')
    // The open state and today's hours were read on the same scope as the menu, so
    // the header cannot disagree with the dishes under it.
    expect(markup).toContain('Open now')
    expect(markup).toContain('Open 24 hours')
  })

  it('marks a dish 86’d in the pinned snapshot as sold out', async () => {
    const loc = await seedLocationWithMenu()
    await seedBusinessHours(loc.id)
    await withLocation(loc.id, (tx) => tx.update(menuItems)
      .set({ is86d: true }).where(eq(menuItems.id, loc.items[1].id)))
    await buildMenuSnapshot(loc.id)

    const markup = await render(loc.storefrontSlug)
    expect(markup).toContain('Lamb Rogan Josh')
    expect(markup).toContain('Sold out today')
  })

  it('is a 404 for a slug nobody owns', async () => {
    await expect(render('no-such-restaurant')).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404/)
  })

  it('is a 404 for the internal slug, which is not a customer’s key', async () => {
    // `locations.slug` is org-scoped and ambiguous across tenants; `storefront_slug`
    // is the public one. Handed the wrong key this finds nothing, which is correct.
    const loc = await storefront()
    await expect(render(loc.slug)).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404/)
  })

  it('is a 404 for a real restaurant that has not pinned a menu yet', async () => {
    // Same answer as "no such restaurant", on purpose: told apart, the page becomes
    // a way to ask which restaurants exist. The reason is logged, not rendered.
    const loc = await seedLocation()
    await expect(render(loc.storefrontSlug)).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404/)
  })
})
