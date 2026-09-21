// Shared test seeders. DB tests run serially against one Neon `test` branch and
// never tear down, so every seed must be collision-proof: unique() suffixes each
// slug/phone. Import these instead of re-inlining a seeder per test file.
//
// Two connections, and which one a seeder uses is not arbitrary:
//
//   db()            organizations and locations — the tenancy root, no RLS on it,
//                   and nothing to scope to until the location row exists.
//   withLocation()  everything under a location. Those tables are under RLS, and
//                   an unscoped write to them is refused, not silently misfiled.
import { db } from '@/db/client'
import {
  organizations, locations, menus, menuCategories, menuItems,
  modifierGroups, modifierOptions, itemModifierGroups, businessHours, orders, orderEvents,
  printers, printJobs,
} from '@/db/schema'
import type { Location, Order, OrderItem, Printer, PrintJob } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { withLocation, type ScopedTx } from '@/repo/scoped'
import { ordersRepo } from '@/repo/orders-repo'
import { buildMenuSnapshot } from '@/domain/snapshot'

let counter = 0
/** Date.now() alone collides — two seeds land in the same millisecond. */
function unique(prefix: string) {
  return `${prefix}-${Date.now()}-${counter++}`
}

type LocationOverrides = Partial<typeof locations.$inferInsert>

export async function seedLocation(overrides: LocationOverrides = {}): Promise<Location> {
  const [org] = await db().insert(organizations).values({ name: 'M', slug: unique('m') }).returning()
  const [loc] = await db().insert(locations).values({
    orgId: org.id,
    name: 'Main',
    slug: unique('main'),
    address: 'x',
    timezone: 'America/New_York',
    phoneE164: '+15550000002',
    taxRateBps: 875,
    ...overrides,
  }).returning()
  return loc
}

/** One row of the weekly grid, minus the ids the seeder fills in. */
export type BusinessHoursRow = Omit<typeof businessHours.$inferInsert, 'id' | 'locationId'>

/**
 * Open every day, all day. `24:00:00` is a legal Postgres `time` and satisfies the
 * `close_time > open_time` CHECK, so this is the whole week in seven rows.
 *
 * The default because most tests want "the restaurant is open" as a precondition,
 * not as the thing under test — and `createOrder` asks `isOpenAt(now)`, where `now`
 * is the real clock, so a fixed Tuesday evening would pass only on Tuesday evening.
 */
export const OPEN_ALL_WEEK: BusinessHoursRow[] = [0, 1, 2, 3, 4, 5, 6].map((dow) => ({
  dow, openTime: '00:00:00', closeTime: '24:00:00',
}))

/**
 * Posts business hours for a location. `business_hours` is under RLS, so the write
 * is scoped; pass a `tx` to seed inside a caller's transaction.
 *
 * Hours are deliberately **not** part of `seedLocationWithMenu`: "closed" is a real
 * state a test needs to be able to seed by simply not calling this.
 */
export async function seedBusinessHours(
  locationId: string,
  rows: BusinessHoursRow[] = OPEN_ALL_WEEK,
  tx?: ScopedTx,
): Promise<void> {
  const values = rows.map((row) => ({ ...row, locationId }))
  if (values.length === 0) return
  if (!tx) {
    await withLocation(locationId, (scoped) => scoped.insert(businessHours).values(values))
    return
  }
  await tx.insert(businessHours).values(values)
}

export type SeededMenu = Location & {
  menu: typeof menus.$inferSelect
  category: typeof menuCategories.$inferSelect
  items: (typeof menuItems.$inferSelect)[]
  modifierGroup: typeof modifierGroups.$inferSelect
  modifierOptions: (typeof modifierOptions.$inferSelect)[]
}

/**
 * A location with one active menu: 1 category, 2 items, 1 modifier group of 2
 * options attached to the first item. Spreads the location, so `.id` is the
 * location id; the menu rows hang off named fields.
 */
export async function seedLocationWithMenu(overrides: LocationOverrides = {}): Promise<SeededMenu> {
  const loc = await seedLocation(overrides)
  return withLocation(loc.id, async (tx) => {
    const [menu] = await tx.insert(menus).values({
      locationId: loc.id, name: 'Dinner', isActive: true,
    }).returning()
    const [category] = await tx.insert(menuCategories).values({
      menuId: menu.id, name: 'Mains', sort: 1,
    }).returning()
    const [modifierGroup] = await tx.insert(modifierGroups).values({
      locationId: loc.id, name: 'Spice Level', minSelect: 1, maxSelect: 1, required: true,
    }).returning()
    const options = await tx.insert(modifierOptions).values([
      { groupId: modifierGroup.id, name: 'Mild', priceDeltaCents: 0 },
      { groupId: modifierGroup.id, name: 'Hot', priceDeltaCents: 50 },
    ]).returning()
    const items = await tx.insert(menuItems).values([
      { categoryId: category.id, name: 'Butter Chicken', description: 'Tomato, cream, fenugreek.', basePriceCents: 1800, sort: 1 },
      { categoryId: category.id, name: 'Lamb Rogan Josh', basePriceCents: 2100, sort: 2 },
    ]).returning()
    await tx.insert(itemModifierGroups).values({ itemId: items[0].id, groupId: modifierGroup.id, sort: 1 })
    return { ...loc, menu, category, items, modifierGroup, modifierOptions: options }
  })
}

export type SeededOrder = {
  snapshot: { id: string; version: number }
  order: Order
  item: OrderItem
}

/** The fields a seeded order may vary. Everything else is fixed, so the totals stay honest. */
type OrderOverrides = Partial<Pick<
  typeof orders.$inferInsert, 'status' | 'paymentStatus' | 'quotedReadyAt' | 'stripePaymentIntentId'
>>

/**
 * One pickup order for a location seeded by `seedLocationWithMenu`: a fresh menu
 * snapshot, the order, one line of 2 Butter Chicken with Hot on it, and the
 * `created` event.
 *
 * Priced off the seeded menu, so nothing here is a magic number:
 *   1800 + 50 = 1850/unit × 2 = 3700 subtotal
 *   tax 3700 × 875bps = 323.75 → 324 (half up), tip 500 → total 4524
 * The arithmetic itself belongs to Task 8's `createOrder`; these are stored values.
 *
 * Snapshot, order, line and event all land in **one** transaction — the same shape
 * a real checkout has, so a test that reads half an order is reading a real bug.
 */
async function seedOrder(locationId: string, over: OrderOverrides): Promise<SeededOrder> {
  return withLocation(locationId, async (tx) => {
    const snapshot = await buildMenuSnapshot(locationId, tx)
    // By name, not `limit(1)`: RLS already narrows these to this location, and a
    // seeder that silently picks a different dish makes its own totals a lie.
    const [butterChicken] = await tx.select().from(menuItems).where(eq(menuItems.name, 'Butter Chicken'))
    const [hot] = await tx.select().from(modifierOptions).where(eq(modifierOptions.name, 'Hot'))

    const order = await ordersRepo(tx).insertOrder({
      locationId,
      shortCode: 'K7M2',
      channel: 'web',
      fulfillment: 'pickup',
      contactName: 'Rohan R',
      contactPhone: '+15551234567',
      contactEmail: 'rohan@example.com',
      subtotalCents: 3700,
      taxCents: 324,
      tipCents: 500,
      totalCents: 4524,
      menuSnapshotId: snapshot.id,
      notes: 'no cilantro',
      status: 'NEW',
      paymentStatus: 'PAID',
      ...over,
    }, [{
      menuItemId: butterChicken.id,
      nameSnapshot: butterChicken.name,
      qty: 2,
      unitPriceCents: 1850,
      lineTotalCents: 3700,
      modifiers: [{ modifierOptionId: hot.id, nameSnapshot: hot.name, priceDeltaCents: hot.priceDeltaCents }],
    }])

    await tx.insert(orderEvents).values({ orderId: order.id, type: 'created', actor: 'system' })
    const [item] = await ordersRepo(tx).itemsFor(order.id)
    return { snapshot, order, item }
  })
}

/** The order as the kitchen sees it: money taken, ticket owed. */
export async function seedPaidOrder(locationId: string): Promise<SeededOrder> {
  return seedOrder(locationId, {})
}

/**
 * A provisioned printer. `serial` is the unit's MAC address and is UNIQUE across
 * the **platform**, so it has to be collision-proof the way slugs are — the `test`
 * branch is never torn down, and a fixed MAC here passes once and 23505s forever
 * after. Shaped like a MAC so a log line from a test reads like a log line from a
 * kitchen.
 */
export async function seedPrinter(locationId: string, serial = macAddress()): Promise<Printer> {
  return withLocation(locationId, async (tx) => {
    const [printer] = await tx.insert(printers)
      .values({ locationId, provider: 'star_cloudprnt', serial })
      .returning()
    return printer
  })
}

/** A MAC in Star's OUI (`00:11:62`), unique per call. */
export function macAddress(): string {
  const tail = (Date.now() * 1000 + counter++).toString(16).padStart(12, '0').slice(-6)
  return `00:11:62:${tail.slice(0, 2)}:${tail.slice(2, 4)}:${tail.slice(4, 6)}`
}

/** One ticket waiting to be collected. `payload` is already-rendered text — see `printJobs`. */
export async function seedPrintJob(locationId: string, orderId: string, payload: string): Promise<PrintJob> {
  return withLocation(locationId, async (tx) => {
    const [job] = await tx.insert(printJobs).values({ locationId, orderId, payload }).returning()
    return job
  })
}

/** Fixed, so the golden's printed pickup time never moves with the clock. */
export const TICKET_READY_AT = new Date('2026-09-21T23:45:00Z')

/**
 * The fully-loaded order the ticket golden pins: two lines, two modifiers and a
 * line note on the first, an order note, and a pickup time that does not move.
 *
 * Its own add-on group rather than `seedLocationWithMenu`'s "Spice Level", because
 * two modifiers off a `maxSelect: 1` group would print a ticket no kitchen could
 * cook ("Mild" and "Hot" on one dish). Inserted directly, not through `createOrder`:
 * this is the renderer under test, not the write path.
 *
 * Priced off the seeded menu, so nothing here is a magic number:
 *   Butter Chicken 1800 + Hot 50 + Extra Paneer 250 = 2100/unit × 2 = 4200
 *   Lamb Rogan Josh 2100 × 1                                       = 2100
 *   subtotal 6300, tax 6300 × 875bps = 551.25 → 551 (half up), tip 500
 *   total 7351
 */
export async function seedTicketOrder(locationId: string): Promise<Order> {
  return withLocation(locationId, async (tx) => {
    const snapshot = await buildMenuSnapshot(locationId, tx)
    const [butterChicken] = await tx.select().from(menuItems).where(eq(menuItems.name, 'Butter Chicken'))
    const [rogan] = await tx.select().from(menuItems).where(eq(menuItems.name, 'Lamb Rogan Josh'))
    const [hot] = await tx.select().from(modifierOptions).where(eq(modifierOptions.name, 'Hot'))

    const [addOns] = await tx.insert(modifierGroups).values({
      locationId, name: 'Add-ons', minSelect: 0, maxSelect: 3, required: false,
    }).returning()
    const [paneer] = await tx.insert(modifierOptions).values({
      groupId: addOns.id, name: 'Extra Paneer', priceDeltaCents: 250,
    }).returning()
    await tx.insert(itemModifierGroups).values({ itemId: butterChicken.id, groupId: addOns.id, sort: 2 })

    const order = await ordersRepo(tx).insertOrder({
      locationId,
      shortCode: 'K7M2',
      channel: 'web',
      fulfillment: 'pickup',
      contactName: 'Rohan R',
      contactPhone: '+15551234567',
      contactEmail: 'rohan@example.com',
      quotedReadyAt: TICKET_READY_AT,
      subtotalCents: 6300,
      taxCents: 551,
      tipCents: 500,
      totalCents: 7351,
      menuSnapshotId: snapshot.id,
      notes: 'no cilantro',
      status: 'NEW',
      paymentStatus: 'PAID',
    }, [{
      menuItemId: butterChicken.id,
      nameSnapshot: butterChicken.name,
      qty: 2,
      unitPriceCents: 2100,
      lineTotalCents: 4200,
      notes: 'extra crispy',
      modifiers: [
        { modifierOptionId: hot.id, nameSnapshot: hot.name, priceDeltaCents: hot.priceDeltaCents },
        { modifierOptionId: paneer.id, nameSnapshot: paneer.name, priceDeltaCents: paneer.priceDeltaCents },
      ],
    }, {
      menuItemId: rogan.id,
      nameSnapshot: rogan.name,
      qty: 1,
      unitPriceCents: 2100,
      lineTotalCents: 2100,
    }])

    await tx.insert(orderEvents).values({ orderId: order.id, type: 'created', actor: 'system' })
    return order
  })
}

/**
 * A card order parked exactly where `createOrder` leaves one: PENDING_PAYMENT /
 * REQUIRES_PAYMENT, with **`quotedReadyAt` null** — no promise is made while the
 * customer is still on the payment form — and the PaymentIntent id already on the
 * row, as `POST /api/orders` writes it.
 *
 * This is the only state the Stripe webhook may flip, so it is the precondition of
 * every test in `src/app/api/stripe/webhook.test.ts`.
 */
export async function seedCardOrder(
  locationId: string,
  /**
   * `null` seeds the **heal path**: an order whose checkout died after the intent
   * existed but before the id reached the row. It is the one state where the webhook
   * cannot check the event against an intent it already knows, so it is the state the
   * account and amount provenance checks have to carry on their own.
   */
  paymentIntentId: string | null = `pi_test_${Date.now()}_${counter++}`,
): Promise<SeededOrder> {
  return seedOrder(locationId, {
    status: 'PENDING_PAYMENT',
    paymentStatus: 'REQUIRES_PAYMENT',
    quotedReadyAt: null,
    stripePaymentIntentId: paymentIntentId,
  })
}
