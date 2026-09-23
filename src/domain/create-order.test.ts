import { describe, it, expect } from 'vitest'
import { desc, eq, inArray } from 'drizzle-orm'
import {
  createOrder, OrderRejectedError,
  InvalidOrderInputError, ItemUnavailableError, LocationClosedError, LocationInactiveError,
  MenuUnavailableError, ModifierSelectionError, OptionUnavailableError,
  UnknownMenuItemError, UnknownModifierOptionError,
  type CreateOrderInput,
} from './create-order'
import { buildMenuSnapshot } from './snapshot'
import {
  menus, menuCategories, menuItems, modifierOptions, itemModifierGroups, menuSnapshots,
  orders, orderItems, orderItemModifiers, orderEvents, orderPauses,
} from '@/db/schema'
import type { MenuSnapshotPayload } from '@/db/schema'
import { withLocation } from '@/repo/scoped'
import { seedLocationWithMenu, seedBusinessHours, type SeededMenu } from '@/test/seed'
import { SHORT_CODE_ALPHABET } from '@/lib/short-code'
import { MAX_TIP_CENTS } from '@/lib/order-limits'

// The contract order, and the reason `Hot` gets repriced below: 2 × (1800 + 200) is
// a subtotal of 4000, taxed at New York City's real rate, with a 500 tip.
//
// **Re-united 2026-09-21.** The plan wrote this rate as "875 bps" — 8.75% — while
// naming it as New York City's, which is 8.875%: 887.5 basis points, a number an
// integer bps column cannot hold. `locations.tax_rate_per_100k` now stores parts per
// 100,000, and the contract numbers move with it: 4000 × 8875 / 100000 = 355 exactly
// (was 350), so the total is 4855 (was 4850). The fixture default in `@/test/seed`
// stays at 8.75% on purpose — see the note there — so this test asks for the real
// rate explicitly, which is also what makes it a test *about* the rate.
const NYC_TAX_PER_100K = 8875
const BUTTER_CHICKEN_CENTS = 1800
const HOT_DELTA_CENTS = 200
const TIP_CENTS = 500
const SUBTOTAL = 4000
const TAX = 355
const TOTAL = 4855

/** By name, never by index: a seeder that reorders its inserts must not silently repoint a test. */
function item(loc: SeededMenu, name: string) {
  const found = loc.items.find((i) => i.name === name)
  if (!found) throw new Error(`seed has no item named ${name}`)
  return found
}

function option(loc: SeededMenu, name: string) {
  const found = loc.modifierOptions.find((o) => o.name === name)
  if (!found) throw new Error(`seed has no modifier option named ${name}`)
  return found
}

/**
 * A restaurant that can take an order right now: the standard seeded menu, hours
 * posted for the whole week (createOrder asks `isOpenAt(new Date())`, so a fixed
 * Tuesday would only pass on a Tuesday), and `Hot` repriced to the plan's +200.
 */
async function openRestaurant(overrides: Parameters<typeof seedLocationWithMenu>[0] = {}): Promise<SeededMenu> {
  const loc = await seedLocationWithMenu(overrides)
  await seedBusinessHours(loc.id)
  await withLocation(loc.id, (tx) => tx.update(modifierOptions)
    .set({ priceDeltaCents: HOT_DELTA_CENTS })
    .where(eq(modifierOptions.id, option(loc, 'Hot').id)))
  return loc
}

/** The plan's order, with any field swapped out. */
function planOrder(loc: SeededMenu, over: Partial<CreateOrderInput> = {}): CreateOrderInput {
  return {
    locationId: loc.id,
    channel: 'web',
    fulfillment: 'pickup',
    contact: { name: 'Rohan R', phone: '+15551234567', email: 'rohan@example.com' },
    items: [{ menuItemId: item(loc, 'Butter Chicken').id, qty: 2, modifierOptionIds: [option(loc, 'Hot').id] }],
    tipCents: TIP_CENTS,
    payment: 'card',
    ...over,
  }
}

/** Everything written for one order, read back the way anything downstream would: scoped. */
async function readOrder(locationId: string, orderId: string) {
  return withLocation(locationId, async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId))
    const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, orderId))
    const modifiers = items.length === 0 ? [] : await tx.select().from(orderItemModifiers)
      .where(inArray(orderItemModifiers.orderItemId, items.map((i) => i.id)))
    const events = await tx.select().from(orderEvents).where(eq(orderEvents.orderId, orderId))
    return { order, items, modifiers, events }
  })
}

/** Every snapshot the location has, newest first. */
async function snapshotsOf(locationId: string) {
  return withLocation(locationId, (tx) => tx.select().from(menuSnapshots)
    .where(eq(menuSnapshots.locationId, locationId))
    .orderBy(desc(menuSnapshots.version)))
}

/** How many orders exist for the location at all — the "nothing was written" assertion. */
async function orderCount(locationId: string): Promise<number> {
  return withLocation(locationId, async (tx) => (await tx.select().from(orders)).length)
}

function pinnedItem(payload: MenuSnapshotPayload, name: string) {
  const found = payload.categories.flatMap((c) => c.items).find((i) => i.name === name)
  if (!found) throw new Error(`snapshot payload has no item named ${name}`)
  return found
}

describe('createOrder — the happy path', () => {
  it('charges the contract numbers exactly: 4000 + 355 + 500 = 4855', async () => {
    const loc = await openRestaurant({ taxRatePer100k: NYC_TAX_PER_100K })
    const result = await createOrder(planOrder(loc))

    expect(result.totalCents).toBe(TOTAL)
    const { order, items, modifiers } = await readOrder(loc.id, result.orderId)
    expect(order).toMatchObject({
      subtotalCents: SUBTOTAL, taxCents: TAX, tipCents: TIP_CENTS,
      deliveryFeeCents: 0, discountCents: 0, totalCents: TOTAL,
    })

    // The line: (1800 + 200) per unit, × 2.
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      nameSnapshot: 'Butter Chicken',
      qty: 2,
      unitPriceCents: BUTTER_CHICKEN_CENTS + HOT_DELTA_CENTS,
      lineTotalCents: SUBTOTAL,
    })
    // Names and prices are copied onto the row — never joined back to the live menu.
    expect(modifiers).toEqual([expect.objectContaining({
      orderItemId: items[0].id,
      modifierOptionId: option(loc, 'Hot').id,
      nameSnapshot: 'Hot',
      priceDeltaCents: HOT_DELTA_CENTS,
    })])
  })

  it('starts a card order at PENDING_PAYMENT / REQUIRES_PAYMENT', async () => {
    const loc = await openRestaurant()
    const result = await createOrder(planOrder(loc, { payment: 'card' }))
    expect(result.status).toBe('PENDING_PAYMENT')
    const { order } = await readOrder(loc.id, result.orderId)
    // Not the kitchen's problem until Stripe says so (Task 9 moves it to NEW).
    expect(order.status).toBe('PENDING_PAYMENT')
    expect(order.paymentStatus).toBe('REQUIRES_PAYMENT')
    expect(order.stripePaymentIntentId).toBeNull()
    // No promise is made while the customer is still on the payment form: a quote
    // issued now would have an unknown amount of itself already spent by the time the
    // kitchen sees the ticket. **Task 9 must set `quotedReadyAt` on the
    // PENDING_PAYMENT → NEW transition**, or a card order never gets a ready time.
    expect(order.quotedReadyAt).toBeNull()
  })

  it('starts a pay-at-pickup order at NEW / PAY_ON_PICKUP', async () => {
    const loc = await openRestaurant()
    const result = await createOrder(planOrder(loc, { payment: 'pay_on_pickup' }))
    expect(result.status).toBe('NEW')
    const { order } = await readOrder(loc.id, result.orderId)
    expect(order.status).toBe('NEW')
    expect(order.paymentStatus).toBe('PAY_ON_PICKUP')
    // Straight to the kitchen, so the promise clock starts now.
    expect(order.quotedReadyAt).toBeInstanceOf(Date)
  })

  it('gives the ticket a short code from the unambiguous alphabet', async () => {
    const loc = await openRestaurant()
    const result = await createOrder(planOrder(loc))
    expect(result.shortCode).toHaveLength(4)
    for (const char of result.shortCode) expect(SHORT_CODE_ALPHABET).toContain(char)
    const { order } = await readOrder(loc.id, result.orderId)
    expect(order.shortCode).toBe(result.shortCode)
  })

  it('records the contact and the channel the order arrived on', async () => {
    const loc = await openRestaurant()
    const result = await createOrder(planOrder(loc, {
      channel: 'voice',
      contact: { name: 'Priya', phone: '+15559876543' },
      items: [{
        menuItemId: item(loc, 'Butter Chicken').id,
        qty: 1,
        modifierOptionIds: [option(loc, 'Mild').id],
        notes: 'no cilantro',
      }],
    }))
    const { order, items } = await readOrder(loc.id, result.orderId)
    expect(order).toMatchObject({
      channel: 'voice', fulfillment: 'pickup', contactName: 'Priya', contactPhone: '+15559876543',
    })
    // Email is optional; phone is how a kitchen chases a no-show.
    expect(order.contactEmail).toBeNull()
    expect(items[0].notes).toBe('no cilantro')
  })

  it('appends exactly one created event, by the customer, carrying the money', async () => {
    const loc = await openRestaurant({ taxRatePer100k: NYC_TAX_PER_100K })
    const result = await createOrder(planOrder(loc))
    const { events } = await readOrder(loc.id, result.orderId)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'created', actor: 'customer' })
    // The audit row has to answer "what was this order" without joining anything.
    expect(events[0].payload).toMatchObject({
      channel: 'web', fulfillment: 'pickup', payment: 'card',
      status: 'PENDING_PAYMENT', paymentStatus: 'REQUIRES_PAYMENT',
      subtotalCents: SUBTOTAL, taxCents: TAX, tipCents: TIP_CENTS, totalCents: TOTAL,
    })
  })

  it('rounds the tax half up on the way into the database', async () => {
    const loc = await openRestaurant()
    // 1960 × 8750 / 100000 = 171.5 exactly — the case truncation gets wrong by a
    // cent. The fixture rate, not New York's: this test is about the rounding.
    await withLocation(loc.id, (tx) => tx.update(menuItems)
      .set({ basePriceCents: 1960 })
      .where(eq(menuItems.id, item(loc, 'Lamb Rogan Josh').id)))

    const result = await createOrder(planOrder(loc, {
      items: [{ menuItemId: item(loc, 'Lamb Rogan Josh').id, qty: 1, modifierOptionIds: [] }],
      tipCents: 0,
    }))
    const { order } = await readOrder(loc.id, result.orderId)
    expect(order.taxCents).toBe(172)
    expect(order.totalCents).toBe(1960 + 172)
  })

  it('keeps two lines of the same dish apart when their modifiers differ', async () => {
    const loc = await openRestaurant()
    const butterChicken = item(loc, 'Butter Chicken').id
    const result = await createOrder(planOrder(loc, {
      items: [
        { menuItemId: butterChicken, qty: 1, modifierOptionIds: [option(loc, 'Mild').id] },
        { menuItemId: butterChicken, qty: 1, modifierOptionIds: [option(loc, 'Hot').id] },
      ],
      tipCents: 0,
    }))
    const { order, items, modifiers } = await readOrder(loc.id, result.orderId)
    // One mild at 1800, one hot at 2000 — not one line of two.
    expect(items).toHaveLength(2)
    expect(items.map((i) => i.unitPriceCents).sort((a, b) => a - b)).toEqual([1800, 2000])
    expect(modifiers.map((m) => m.nameSnapshot).sort()).toEqual(['Hot', 'Mild'])
    expect(order.subtotalCents).toBe(3800)
  })
})

describe('createOrder — the pinned menu', () => {
  it('pins a snapshot whose prices are the prices it charged', async () => {
    const loc = await openRestaurant()
    const result = await createOrder(planOrder(loc))
    const { order, items, modifiers } = await readOrder(loc.id, result.orderId)

    expect(order.menuSnapshotId).not.toBeNull()
    const [snapshot] = await snapshotsOf(loc.id)
    expect(order.menuSnapshotId).toBe(snapshot.id)
    // Same location — the composite FK makes the other case unrepresentable, and
    // this is the assertion that says so out loud.
    expect(snapshot.locationId).toBe(loc.id)

    const pinned = pinnedItem(snapshot.payload, 'Butter Chicken')
    const pinnedHot = pinned.modifierGroups[0].options.find((o) => o.name === 'Hot')!
    expect(pinned.basePriceCents).toBe(BUTTER_CHICKEN_CENTS)
    expect(pinnedHot.priceDeltaCents).toBe(HOT_DELTA_CENTS)
    // The receipt and the evidence have to agree, or a dispute is unanswerable.
    expect(items[0].unitPriceCents).toBe(pinned.basePriceCents + pinnedHot.priceDeltaCents)
    expect(modifiers[0].priceDeltaCents).toBe(pinnedHot.priceDeltaCents)
  })

  it('builds the first snapshot when the location has none', async () => {
    const loc = await openRestaurant()
    expect(await snapshotsOf(loc.id)).toHaveLength(0)
    await createOrder(planOrder(loc))
    const snapshots = await snapshotsOf(loc.id)
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0].version).toBe(1)
  })

  it('reuses the current snapshot instead of rebuilding one per order', async () => {
    const loc = await openRestaurant()
    const existing = await buildMenuSnapshot(loc.id)

    const first = await createOrder(planOrder(loc))
    const second = await createOrder(planOrder(loc))

    // Dinner rush: 200 orders must not mean 200 copies of the whole menu.
    const snapshots = await snapshotsOf(loc.id)
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0].id).toBe(existing.id)
    const [a, b] = await Promise.all([
      readOrder(loc.id, first.orderId), readOrder(loc.id, second.orderId),
    ])
    expect(a.order.menuSnapshotId).toBe(existing.id)
    expect(b.order.menuSnapshotId).toBe(existing.id)
  })

  it('pins the newest snapshot, not the first one ever built', async () => {
    const loc = await openRestaurant()
    await buildMenuSnapshot(loc.id)
    const newest = await buildMenuSnapshot(loc.id)
    expect(newest.version).toBe(2)
    const result = await createOrder(planOrder(loc))
    const { order } = await readOrder(loc.id, result.orderId)
    expect(order.menuSnapshotId).toBe(newest.id)
  })
})

/**
 * The order has to be priced from the same universe the snapshot pins: the
 * location's one active menu. `menu_items.isActive` alone does not say that — a whole
 * menu can be switched off with every item on it still flagged active.
 */
describe('createOrder — the menu it prices from', () => {
  it('refuses to sell off a deactivated menu, even with a snapshot already on file', async () => {
    const loc = await openRestaurant()
    // The stale snapshot is the point: without this the order would land, pinned to
    // a payload that does not contain the dish it charged for.
    await buildMenuSnapshot(loc.id)
    await withLocation(loc.id, (tx) => tx.update(menus)
      .set({ isActive: false }).where(eq(menus.id, loc.menu.id)))

    await expect(createOrder(planOrder(loc))).rejects.toThrow(MenuUnavailableError)
    expect(await orderCount(loc.id)).toBe(0)
  })

  it('refuses to guess when the location has two active menus', async () => {
    const loc = await openRestaurant()
    await buildMenuSnapshot(loc.id)
    // buildMenuSnapshot refuses this state outright; the order path must refuse it
    // too rather than quietly falling back on the last good snapshot.
    await withLocation(loc.id, (tx) => tx.insert(menus)
      .values({ locationId: loc.id, name: 'Late Night', isActive: true }))

    await expect(createOrder(planOrder(loc))).rejects.toThrow(MenuUnavailableError)
    expect(await orderCount(loc.id)).toBe(0)
  })

  it('refuses an item that lives on a menu other than the active one', async () => {
    // The contract rate, because the closing assertion is the contract total.
    const loc = await openRestaurant({ taxRatePer100k: NYC_TAX_PER_100K })
    // Last winter's menu, switched off, its dishes still flagged active. They are
    // not on sale and they are not in the snapshot — so they are not orderable.
    const offMenuItemId = await withLocation(loc.id, async (tx) => {
      const [old] = await tx.insert(menus)
        .values({ locationId: loc.id, name: 'Last Winter', isActive: false }).returning()
      const [category] = await tx.insert(menuCategories)
        .values({ menuId: old.id, name: 'Mains', sort: 1 }).returning()
      const [dish] = await tx.insert(menuItems)
        .values({ categoryId: category.id, name: 'Goat Curry', basePriceCents: 2400, sort: 1 }).returning()
      return dish.id
    })

    await expect(createOrder(planOrder(loc, {
      items: [{ menuItemId: offMenuItemId, qty: 1, modifierOptionIds: [] }],
    }))).rejects.toThrow(UnknownMenuItemError)
    // And the active menu still sells, priced the same as ever.
    await expect(createOrder(planOrder(loc))).resolves.toMatchObject({ totalCents: TOTAL })
  })
})

describe('createOrder — server-side validation', () => {
  it('refuses an 86\'d item', async () => {
    const loc = await openRestaurant()
    await withLocation(loc.id, (tx) => tx.update(menuItems)
      .set({ is86d: true }).where(eq(menuItems.id, item(loc, 'Butter Chicken').id)))
    await expect(createOrder(planOrder(loc))).rejects.toThrow(ItemUnavailableError)
    expect(await orderCount(loc.id)).toBe(0)
  })

  it('refuses an 86\'d modifier option', async () => {
    const loc = await openRestaurant()
    // Running out of a topping is as common as running out of a dish, and the
    // snapshot alone would not catch it — this has to be checked live.
    await withLocation(loc.id, (tx) => tx.update(modifierOptions)
      .set({ is86d: true }).where(eq(modifierOptions.id, option(loc, 'Hot').id)))
    await expect(createOrder(planOrder(loc))).rejects.toThrow(OptionUnavailableError)
    expect(await orderCount(loc.id)).toBe(0)
  })

  it('refuses fewer selections than minSelect', async () => {
    const loc = await openRestaurant()
    await expect(createOrder(planOrder(loc, {
      items: [{ menuItemId: item(loc, 'Butter Chicken').id, qty: 2, modifierOptionIds: [] }],
    }))).rejects.toThrow(ModifierSelectionError)
  })

  it('refuses more selections than maxSelect', async () => {
    const loc = await openRestaurant()
    await expect(createOrder(planOrder(loc, {
      items: [{
        menuItemId: item(loc, 'Butter Chicken').id,
        qty: 1,
        modifierOptionIds: [option(loc, 'Mild').id, option(loc, 'Hot').id],
      }],
    }))).rejects.toThrow(ModifierSelectionError)
  })

  it('enforces the item\'s effective limits, not the group\'s defaults — and pins the same numbers', async () => {
    const loc = await openRestaurant()
    // Spice Level is min 1 / max 1 / required on the group. This item opts out of
    // the minimum and allows two. `required: true` does not outrank minSelect: 0.
    await withLocation(loc.id, (tx) => tx.update(itemModifierGroups)
      .set({ minOverride: 0, maxOverride: 2 })
      .where(eq(itemModifierGroups.itemId, item(loc, 'Butter Chicken').id)))

    const none = await createOrder(planOrder(loc, {
      items: [{ menuItemId: item(loc, 'Butter Chicken').id, qty: 1, modifierOptionIds: [] }],
      tipCents: 0,
    }))
    const both = await createOrder(planOrder(loc, {
      items: [{
        menuItemId: item(loc, 'Butter Chicken').id,
        qty: 1,
        modifierOptionIds: [option(loc, 'Mild').id, option(loc, 'Hot').id],
      }],
      tipCents: 0,
    }))

    const noneRows = await readOrder(loc.id, none.orderId)
    expect(noneRows.items[0].unitPriceCents).toBe(BUTTER_CHICKEN_CENTS)
    const bothRows = await readOrder(loc.id, both.orderId)
    expect(bothRows.modifiers).toHaveLength(2)

    // What was enforced is what was pinned: the payload has to show the same rule.
    const [snapshot] = await snapshotsOf(loc.id)
    expect(pinnedItem(snapshot.payload, 'Butter Chicken').modifierGroups[0])
      .toMatchObject({ minSelect: 0, maxSelect: 2, required: true })
  })

  it('refuses an item id that is not on this location\'s menu', async () => {
    const loc = await openRestaurant()
    await expect(createOrder(planOrder(loc, {
      items: [{
        menuItemId: '00000000-0000-0000-0000-000000000000', qty: 1, modifierOptionIds: [],
      }],
    }))).rejects.toThrow(UnknownMenuItemError)
  })

  it('refuses another restaurant\'s item id, which is not even visible here', async () => {
    const mine = await openRestaurant()
    const theirs = await openRestaurant()
    // RLS hides the row, so this reads as "no such dish" rather than "forbidden" —
    // and either way it must never be priced onto my order.
    await expect(createOrder(planOrder(mine, {
      items: [{ menuItemId: item(theirs, 'Butter Chicken').id, qty: 1, modifierOptionIds: [] }],
    }))).rejects.toThrow(UnknownMenuItemError)
  })

  it('refuses a dish or an option that has been retired from the menu', async () => {
    const loc = await openRestaurant()
    // `isActive: false` is how the menu editor retires something — the row stays for
    // the old orders that reference it, and `buildMenuSnapshot` leaves it out. From
    // the customer's side it does not exist, which is the answer they get.
    await withLocation(loc.id, async (tx) => {
      await tx.update(menuItems).set({ isActive: false })
        .where(eq(menuItems.id, item(loc, 'Lamb Rogan Josh').id))
      await tx.update(modifierOptions).set({ isActive: false })
        .where(eq(modifierOptions.id, option(loc, 'Hot').id))
    })

    await expect(createOrder(planOrder(loc, {
      items: [{ menuItemId: item(loc, 'Lamb Rogan Josh').id, qty: 1, modifierOptionIds: [] }],
    }))).rejects.toThrow(UnknownMenuItemError)
    await expect(createOrder(planOrder(loc))).rejects.toThrow(UnknownModifierOptionError)
  })

  it('refuses an option that exists but is not offered on the item ordered', async () => {
    const loc = await openRestaurant()
    // Lamb Rogan Josh has no modifier groups at all. Accepting Hot here would let a
    // client staple any price delta it liked onto any dish.
    await expect(createOrder(planOrder(loc, {
      items: [{
        menuItemId: item(loc, 'Lamb Rogan Josh').id, qty: 1, modifierOptionIds: [option(loc, 'Hot').id],
      }],
    }))).rejects.toThrow(UnknownModifierOptionError)
  })

  it('refuses an option id that does not exist', async () => {
    const loc = await openRestaurant()
    await expect(createOrder(planOrder(loc, {
      items: [{
        menuItemId: item(loc, 'Butter Chicken').id,
        qty: 1,
        modifierOptionIds: ['00000000-0000-0000-0000-000000000000'],
      }],
    }))).rejects.toThrow(UnknownModifierOptionError)
  })

  it('refuses the same option twice on one line', async () => {
    const loc = await openRestaurant()
    // (order_item_id, modifier_option_id) is the primary key, so "extra shot ×2" is
    // not representable. Saying so here beats a 23505 from the driver.
    await expect(createOrder(planOrder(loc, {
      items: [{
        menuItemId: item(loc, 'Butter Chicken').id,
        qty: 1,
        modifierOptionIds: [option(loc, 'Hot').id, option(loc, 'Hot').id],
      }],
    }))).rejects.toThrow(InvalidOrderInputError)
  })

  it('refuses an order with no lines, a non-positive quantity, or a negative tip', async () => {
    const loc = await openRestaurant()
    await expect(createOrder(planOrder(loc, { items: [] }))).rejects.toThrow(InvalidOrderInputError)
    await expect(createOrder(planOrder(loc, {
      items: [{ menuItemId: item(loc, 'Butter Chicken').id, qty: 0, modifierOptionIds: [option(loc, 'Hot').id] }],
    }))).rejects.toThrow(InvalidOrderInputError)
    await expect(createOrder(planOrder(loc, { tipCents: -1 }))).rejects.toThrow(InvalidOrderInputError)
  })

  it('refuses an order too large to price exactly or to write in one transaction', async () => {
    const loc = await openRestaurant()
    const line = { menuItemId: item(loc, 'Butter Chicken').id, modifierOptionIds: [option(loc, 'Hot').id] }
    // A quantity that is still a legal integer but multiplies out past exact integer
    // arithmetic has to be a rejection, not a 500 from deep inside the tax math.
    await expect(createOrder(planOrder(loc, { items: [{ ...line, qty: 1e15 }] })))
      .rejects.toThrow(InvalidOrderInputError)
    // One INSERT per line, inside the open transaction.
    await expect(createOrder(planOrder(loc, { items: Array.from({ length: 101 }, () => ({ ...line, qty: 1 })) })))
      .rejects.toThrow(InvalidOrderInputError)
  })

  it('refuses an id that is not a uuid, before it queries anything', async () => {
    const loc = await openRestaurant()
    // A junk id reaching the query is a 22P02 that poisons the whole transaction and
    // surfaces as a 500 — on the public write path, triggered by whatever a client
    // puts in the body. Shape is checked with everything else in the request.
    await expect(createOrder(planOrder(loc, { locationId: 'not-a-uuid' })))
      .rejects.toThrow(InvalidOrderInputError)
    await expect(createOrder(planOrder(loc, {
      items: [{ menuItemId: 'butter-chicken', qty: 1, modifierOptionIds: [] }],
    }))).rejects.toThrow(InvalidOrderInputError)
    await expect(createOrder(planOrder(loc, {
      items: [{ menuItemId: item(loc, 'Butter Chicken').id, qty: 1, modifierOptionIds: ['hot'] }],
    }))).rejects.toThrow(InvalidOrderInputError)
    expect(await orderCount(loc.id)).toBe(0)
  })

  it('rejects with a coded, named error the HTTP layer can map', async () => {
    const loc = await openRestaurant()
    await withLocation(loc.id, (tx) => tx.update(menuItems)
      .set({ is86d: true }).where(eq(menuItems.id, item(loc, 'Butter Chicken').id)))

    // The contract Task 9's route is built on: one base class to catch, a stable
    // code to pass on, and a name that says which rejection it was.
    const err = await createOrder(planOrder(loc)).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(OrderRejectedError)
    expect(err).toMatchObject({ code: 'item_unavailable', name: 'ItemUnavailableError' })
    // The message is customer-facing, so it names the dish rather than an id.
    expect((err as Error).message).toContain('Butter Chicken')
  })

  it('refuses a payment mode or a fulfillment it does not recognise', async () => {
    const loc = await openRestaurant()
    // Both are typed shut and both are checked anyway, because the API boundary
    // (Task 9) parses JSON: an unrecognised payment mode would otherwise fall
    // through the `=== 'card'` ternaries and become a free order, and anything but
    // pickup would take the hardcoded delivery fee of 0.
    await expect(createOrder({ ...planOrder(loc), payment: 'cash' } as unknown as CreateOrderInput))
      .rejects.toThrow(InvalidOrderInputError)
    await expect(createOrder({ ...planOrder(loc), fulfillment: 'delivery' } as unknown as CreateOrderInput))
      .rejects.toThrow(InvalidOrderInputError)
    expect(await orderCount(loc.id)).toBe(0)
  })

  it('refuses a channel it does not recognise', async () => {
    const loc = await openRestaurant()
    // Same hazard as payment/fulfillment above, one column over: `channel` is a
    // Postgres enum, so an unrecognised value would sail past every other check,
    // burn the whole pricing read, and only then 22P02 at the INSERT.
    await expect(createOrder({ ...planOrder(loc), channel: 'carrier-pigeon' } as unknown as CreateOrderInput))
      .rejects.toThrow(InvalidOrderInputError)
    expect(await orderCount(loc.id)).toBe(0)
  })

  it('refuses a blank contact name or phone', async () => {
    const loc = await openRestaurant()
    // The phone is the whole identity of a guest order — it is how a kitchen chases
    // a no-show pickup — and a voice agent that heard nothing must not write ''.
    await expect(createOrder(planOrder(loc, { contact: { name: '  ', phone: '+15551234567' } })))
      .rejects.toThrow(InvalidOrderInputError)
    await expect(createOrder(planOrder(loc, { contact: { name: 'Rohan R', phone: '' } })))
      .rejects.toThrow(InvalidOrderInputError)
  })

  it('refuses a non-string contact email or line note', async () => {
    const loc = await openRestaurant()
    // Both are nullable text columns with no shape check of their own — a number
    // or object here must not reach `contact_email`/`notes` unvalidated.
    await expect(createOrder(planOrder(loc, {
      contact: { name: 'Rohan R', phone: '+15551234567', email: 12345 as unknown as string },
    }))).rejects.toThrow(InvalidOrderInputError)
    await expect(createOrder(planOrder(loc, {
      items: [{
        menuItemId: item(loc, 'Butter Chicken').id, qty: 1,
        modifierOptionIds: [option(loc, 'Hot').id], notes: 42 as unknown as string,
      }],
    }))).rejects.toThrow(InvalidOrderInputError)
    expect(await orderCount(loc.id)).toBe(0)
  })

  it('refuses a contact email or line note past the length cap', async () => {
    const loc = await openRestaurant()
    const tooLong = 'x'.repeat(501)
    await expect(createOrder(planOrder(loc, {
      contact: { name: 'Rohan R', phone: '+15551234567', email: tooLong },
    }))).rejects.toThrow(InvalidOrderInputError)
    await expect(createOrder(planOrder(loc, {
      items: [{
        menuItemId: item(loc, 'Butter Chicken').id, qty: 1,
        modifierOptionIds: [option(loc, 'Hot').id], notes: tooLong,
      }],
    }))).rejects.toThrow(InvalidOrderInputError)
    expect(await orderCount(loc.id)).toBe(0)
  })

  it('takes a tip right up to the cap, and refuses one cent more', async () => {
    // **The tip is the only money value on this path the client supplies** — every
    // other number comes off the menu inside the transaction. Unbounded,
    // `Number.isSafeInteger` accepts 9007199254740991, and that total is handed to
    // Stripe verbatim as the PaymentIntent amount: refused *after* the order row is
    // committed, so the row parks at PENDING_PAYMENT and the customer gets a 500.
    // Pay-at-pickup does not even get that — it prints the nonsense total on a ticket.
    const loc = await openRestaurant()

    const { orderId } = await createOrder(planOrder(loc, {
      tipCents: MAX_TIP_CENTS, payment: 'pay_on_pickup',
    }))
    const { order } = await readOrder(loc.id, orderId)
    // At the cap exactly: accepted, stored verbatim, and carried into the total.
    // Asserted against the row's own parts rather than restated arithmetic — this
    // restaurant is seeded at the fixture rate, not New York's, and a second copy of
    // the tax sum here would only ever be a way for this test to be wrong.
    expect(order.tipCents).toBe(MAX_TIP_CENTS)
    expect(order.totalCents).toBe(order.subtotalCents + order.taxCents + MAX_TIP_CENTS)
    expect(order.subtotalCents).toBe(SUBTOTAL)

    await expect(createOrder(planOrder(loc, { tipCents: MAX_TIP_CENTS + 1 })))
      .rejects.toThrow(InvalidOrderInputError)
    // The code is the contract the HTTP layer maps, not the message.
    await expect(createOrder(planOrder(loc, { tipCents: MAX_TIP_CENTS + 1 })))
      .rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('refuses the tip values that would reach Stripe as a nonsense amount', async () => {
    const loc = await openRestaurant()
    // `MAX_SAFE_INTEGER` is the one that passes every other check in this function.
    for (const tipCents of [Number.MAX_SAFE_INTEGER, 1_000_000_000, MAX_TIP_CENTS * 2]) {
      await expect(createOrder(planOrder(loc, { tipCents })), String(tipCents))
        .rejects.toThrow(InvalidOrderInputError)
    }
    // Refused before a connection is opened, so nothing was written for any of them.
    expect(await orderCount(loc.id)).toBe(0)
  })

  it('refuses a phone that is not E.164, whatever channel it arrived on', async () => {
    const loc = await openRestaurant()
    // The column is plain `text`, and everything downstream of it assumes E.164: the
    // owner's SMS goes through `sendSms`, which refuses anything else *at send time* —
    // by which point the order is committed, the kitchen has the ticket, and the
    // customer is simply never texted. Checked here instead, where it is still a
    // rejection the caller can act on.
    //
    // **Every channel, not just the web form.** The web form normalises before it
    // posts, so on that path this is belt and braces; the voice and SMS agents call
    // `createOrder` directly, and "(555) 123-4567" is exactly what a transcription
    // hands back. One rule, applied to every writer, is the only version of this that
    // cannot be routed around.
    const notE164 = ['5551234567', '(555) 123-4567', '+1', '', '  ', '+0555123456', 'five five five']
    for (const phone of notE164) {
      await expect(
        createOrder(planOrder(loc, { contact: { name: 'Rohan R', phone } })),
        JSON.stringify(phone),
      ).rejects.toThrow(InvalidOrderInputError)
    }
    for (const channel of ['voice', 'sms'] as const) {
      await expect(createOrder(planOrder(loc, {
        channel, contact: { name: 'Rohan R', phone: '5551234567' },
      }))).rejects.toThrow(InvalidOrderInputError)
    }
    expect(await orderCount(loc.id)).toBe(0)
  })

  it('takes the E.164 numbers a real order arrives with', async () => {
    const loc = await openRestaurant()
    // The shape rule is not a US rule: a `+44` number is a legitimate E.164 value and
    // must not be refused by a regex written around the one country we launch in.
    for (const phone of ['+15551234567', '+442071234567']) {
      const { orderId } = await createOrder(planOrder(loc, {
        contact: { name: 'Rohan R', phone }, payment: 'pay_on_pickup',
      }))
      const { order } = await readOrder(loc.id, orderId)
      expect(order.contactPhone).toBe(phone)
    }
  })

  it('writes nothing at all when one line of a multi-line order is rejected', async () => {
    const loc = await openRestaurant()
    await withLocation(loc.id, (tx) => tx.update(menuItems)
      .set({ is86d: true }).where(eq(menuItems.id, item(loc, 'Lamb Rogan Josh').id)))

    await expect(createOrder(planOrder(loc, {
      items: [
        { menuItemId: item(loc, 'Butter Chicken').id, qty: 1, modifierOptionIds: [option(loc, 'Hot').id] },
        { menuItemId: item(loc, 'Lamb Rogan Josh').id, qty: 1, modifierOptionIds: [] },
      ],
    }))).rejects.toThrow(ItemUnavailableError)

    // Not "the bad line was dropped" — no order, no lines, no event.
    expect(await orderCount(loc.id)).toBe(0)
    await withLocation(loc.id, async (tx) => {
      expect(await tx.select().from(orderItems)).toHaveLength(0)
      expect(await tx.select().from(orderEvents)).toHaveLength(0)
    })
  })
})

/**
 * TCPA consent, captured at checkout and stored on the order row.
 *
 * The legal shape of this is not a preference, and it is why the two columns are
 * separate: `sms_marketing_consent` is *what* was agreed to, and `consent_at` is the
 * evidence of *when* — which is the half a regulator, or a plaintiff's lawyer, asks
 * for. A boolean on its own cannot say whether consent was given today or inherited
 * from a row written before the box existed.
 *
 * Marketing only. Transactional messages — "your order is ready" — need no consent
 * and are not gated on this, which is why nothing in the fan-out reads it.
 */
describe('createOrder — SMS marketing consent', () => {
  it('stamps both columns only when the box was actually ticked', async () => {
    const loc = await openRestaurant()

    const opted = await createOrder(planOrder(loc, {
      payment: 'pay_on_pickup', smsMarketingConsent: true,
    }))
    const yes = (await readOrder(loc.id, opted.orderId)).order
    expect(yes.smsMarketingConsent).toBe(true)
    // The moment, not merely a non-null: this is the evidence half of the record.
    expect(yes.consentAt).toBeInstanceOf(Date)
    expect(Math.abs(yes.consentAt!.getTime() - yes.createdAt.getTime())).toBeLessThan(60_000)

    const declined = await createOrder(planOrder(loc, {
      payment: 'pay_on_pickup', smsMarketingConsent: false,
    }))
    const no = (await readOrder(loc.id, declined.orderId)).order
    expect(no.smsMarketingConsent).toBe(false)
    // **Null, not "some time".** A timestamp beside a false flag is a row that cannot
    // be read as anything but consent, whatever the boolean says.
    expect(no.consentAt).toBeNull()
  })

  it('defaults to no consent when the field is absent entirely', async () => {
    // The voice and SMS agents predate this field and will keep posting without it.
    // Absent must mean "did not consent" — never "unknown", and never true.
    const loc = await openRestaurant()
    const { orderId } = await createOrder(planOrder(loc, { payment: 'pay_on_pickup' }))
    const { order } = await readOrder(loc.id, orderId)
    expect(order.smsMarketingConsent).toBe(false)
    expect(order.consentAt).toBeNull()
  })

  it('refuses a consent flag that is not a boolean', async () => {
    const loc = await openRestaurant()
    // `'false'`, `0` and `'on'` are the three shapes a form serialiser actually
    // produces, and two of them are truthy. Coerced rather than refused, the string
    // `'false'` would opt a customer in to marketing they declined — which is the one
    // bug in this file that is a legal problem rather than a support ticket.
    for (const bad of ['true', 'false', 'on', 1, 0, null, {}]) {
      await expect(
        createOrder(planOrder(loc, { smsMarketingConsent: bad as unknown as boolean })),
        JSON.stringify(bad),
      ).rejects.toThrow(InvalidOrderInputError)
    }
    expect(await orderCount(loc.id)).toBe(0)
  })
})

describe('createOrder — when the restaurant cannot take it', () => {
  it('refuses when the location is closed, and says so', async () => {
    const loc = await seedLocationWithMenu()
    // No hours posted at all: closed, for the reason isOpenAt gives.
    await expect(createOrder(planOrder(loc))).rejects.toThrow(LocationClosedError)
    await expect(createOrder(planOrder(loc))).rejects.toMatchObject({ reason: 'closed_hours' })
    expect(await orderCount(loc.id)).toBe(0)
  })

  it('refuses while the kitchen has paused ordering, and says that instead', async () => {
    const loc = await openRestaurant()
    await withLocation(loc.id, (tx) => tx.insert(orderPauses).values({
      locationId: loc.id, until: new Date(Date.now() + 60 * 60_000), reason: 'slammed',
    }))
    // "Try again in an hour", not "come back Tuesday" — the reason is what the
    // customer and the voice agent are told.
    await expect(createOrder(planOrder(loc))).rejects.toMatchObject({ reason: 'paused' })
  })

  it('refuses when the location itself is not active', async () => {
    const loc = await openRestaurant({ status: 'suspended' })
    // A suspended restaurant can be open by the clock and still must not take money.
    await expect(createOrder(planOrder(loc))).rejects.toThrow(LocationInactiveError)
    expect(await orderCount(loc.id)).toBe(0)
  })

  it('refuses to guess for a location that does not exist', async () => {
    const loc = await openRestaurant()
    await expect(createOrder(planOrder(loc, {
      locationId: '00000000-0000-0000-0000-000000000000',
    }))).rejects.toThrow(/unknown location/i)
  })
})
