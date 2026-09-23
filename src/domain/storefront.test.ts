import { describe, it, expect } from 'vitest'
import { desc, eq } from 'drizzle-orm'
import { menuItems, menuSnapshots, orderPauses } from '@/db/schema'
import type { MenuSnapshotPayload } from '@/db/schema'
import { withLocation } from '@/repo/scoped'
import { buildMenuSnapshot } from '@/domain/snapshot'
import { storefrontView, NoMenuError } from './storefront'
import { seedLocationWithMenu, seedBusinessHours, type SeededMenu } from '@/test/seed'

/**
 * What a customer's phone is handed when they open a restaurant's menu.
 *
 * The rule the whole file exists to pin: **browse reads the pinned snapshot, never
 * the live menu tables.** A restaurant whose database write path is down still has a
 * menu people can read, and what they read is byte-for-byte what `createOrder` will
 * price against — the two cannot drift, because they are the same row.
 */

/** Every snapshot this location has ever had, newest first. */
function snapshots(locationId: string) {
  return withLocation(locationId, (tx) => tx.select().from(menuSnapshots)
    .where(eq(menuSnapshots.locationId, locationId))
    .orderBy(desc(menuSnapshots.version)))
}

/** The payload of the row the view claims to be serving, read back independently. */
async function payloadOf(locationId: string, version: number): Promise<MenuSnapshotPayload> {
  const rows = await snapshots(locationId)
  return rows.find((row) => row.version === version)!.payload
}

/** Open all week, one menu, one snapshot pinned — a restaurant ready to be browsed. */
async function storefront(over: Parameters<typeof seedLocationWithMenu>[0] = {}): Promise<SeededMenu> {
  const loc = await seedLocationWithMenu(over)
  await seedBusinessHours(loc.id)
  await buildMenuSnapshot(loc.id)
  return loc
}

describe('storefrontView', () => {
  it('carries the pinned snapshot verbatim, 86 flags included', async () => {
    const loc = await seedLocationWithMenu()
    await seedBusinessHours(loc.id)
    // Sold out today. The snapshot is rebuilt after the toggle, the way the 86 route
    // rebuilds it in the same transaction as the change.
    await withLocation(loc.id, (tx) => tx.update(menuItems)
      .set({ is86d: true }).where(eq(menuItems.id, loc.items[1].id)))
    const pinned = await buildMenuSnapshot(loc.id)

    const view = await storefrontView(loc.id)

    expect(view.snapshotVersion).toBe(pinned.version)
    // Verbatim, not "equivalent": the categories are the payload, compared against
    // the row itself rather than against a hand-written expectation that could drift.
    expect(view.categories).toEqual((await payloadOf(loc.id, pinned.version)).categories)

    const items = view.categories[0].items
    // **Included and marked, not hidden.** A greyed-out dish tells a customer the
    // restaurant sells it; dropping the row makes the menu look thinner than it is.
    expect(items).toHaveLength(2)
    expect(items.map((item) => item.name)).toContain('Lamb Rogan Josh')
    expect(items.find((item) => item.name === 'Lamb Rogan Josh')!.is86d).toBe(true)
    expect(items.find((item) => item.name === 'Butter Chicken')!.is86d).toBe(false)

    // The modifier rules the dish sheet enforces come pinned too — effective limits,
    // not the group's defaults. See `SnapshotModifierGroup.minSelect`.
    const group = items.find((item) => item.name === 'Butter Chicken')!.modifierGroups[0]
    expect(group).toMatchObject({ name: 'Spice Level', minSelect: 1, maxSelect: 1 })
    expect(group.options.map((option) => option.name)).toEqual(['Hot', 'Mild'])
  })

  it('serves the pinned menu, not the live tables', async () => {
    // The constraint of this whole plan. A price edited after the pin, and a dish
    // added after it, are both invisible until somebody rebuilds the snapshot —
    // which is exactly what keeps browse agreeing with what an order pins.
    const loc = await storefront()
    await withLocation(loc.id, async (tx) => {
      await tx.update(menuItems).set({ basePriceCents: 9900 })
        .where(eq(menuItems.id, loc.items[0].id))
      await tx.insert(menuItems).values({
        categoryId: loc.category.id, name: 'Off-Snapshot Special', basePriceCents: 100, sort: 9,
      })
    })

    const view = await storefrontView(loc.id)
    const items = view.categories[0].items
    expect(items.find((item) => item.name === 'Butter Chicken')!.basePriceCents).toBe(1800)
    expect(items.map((item) => item.name)).not.toContain('Off-Snapshot Special')
  })

  it('serves the newest pin when the menu has moved on', async () => {
    const loc = await storefront()
    await withLocation(loc.id, (tx) => tx.update(menuItems)
      .set({ basePriceCents: 2000 }).where(eq(menuItems.id, loc.items[0].id)))
    const rebuilt = await buildMenuSnapshot(loc.id)

    const view = await storefrontView(loc.id)
    expect(view.snapshotVersion).toBe(rebuilt.version)
    expect(view.categories[0].items.find((item) => item.name === 'Butter Chicken')!.basePriceCents).toBe(2000)
  })

  it('still serves a snapshot pinned before the dish card had fields to pin', async () => {
    // **`menu_snapshots` is insert-only**, so the rows that predate `description`,
    // `photoUrl` and `tags` will never grow them: rewriting a row is forbidden — it
    // is the evidence an order was priced against. Every reader therefore has to
    // tolerate the fields being absent, and this is the test that holds it that way.
    // A legacy payload is written here by hand because that is the only way one can
    // exist: `buildMenuSnapshot` has populated them since 2026-09-22.
    const loc = await seedLocationWithMenu()
    await seedBusinessHours(loc.id)
    const legacy: MenuSnapshotPayload = {
      menuId: loc.menu.id,
      categories: [{
        id: loc.category.id,
        name: 'Mains',
        items: [{
          id: loc.items[0].id,
          name: 'Butter Chicken',
          basePriceCents: 1800,
          is86d: false,
          modifierGroups: [],
        }],
      }],
    }
    await withLocation(loc.id, (tx) => tx.insert(menuSnapshots)
      .values({ locationId: loc.id, version: 1, payload: legacy }))

    // Reads, rather than throwing or filling the gaps from the live tables.
    const view = await storefrontView(loc.id)
    const [item] = view.categories[0].items
    expect(item.name).toBe('Butter Chicken')
    expect(item.basePriceCents).toBe(1800)
    // Absent, not null: nothing invented a value for a row nobody may rewrite.
    expect(item.description).toBeUndefined()
    expect(item.photoUrl).toBeUndefined()
    expect(item.tags).toBeUndefined()
  })

  it('carries the location a customer needs, and the open state with its reason', async () => {
    const loc = await storefront({ stripeAccountId: 'acct_test_view' })

    const open = await storefrontView(loc.id)
    expect(open.location).toEqual({
      name: loc.name,
      // **The public routing key, not the internal one.** `slug` here is
      // `locations.storefront_slug` — platform-unique, and what `/order/[slug]`
      // resolves. `locations.slug` stays org-scoped and stays behind the login.
      slug: loc.storefrontSlug,
      timezone: loc.timezone,
      phoneE164: loc.phoneE164,
      address: loc.address,
      prepTimeMinutes: loc.prepTimeMinutes,
      // The cart renders a tax line before there is an order to ask about, so the
      // rate travels with the menu. Display-only: `POST /api/orders` recomputes it.
      taxRatePer100k: loc.taxRatePer100k,
      // The connected account, because the customer's own browser has to name it to
      // confirm a direct charge — it is in the header of every Stripe.js call it
      // makes. An identifier, not a credential; see `StorefrontLocation`.
      stripeAccountId: 'acct_test_view',
    })
    expect(open.location.slug).not.toBe(loc.slug)
    expect(open.open).toEqual({ open: true })

    // "We're slammed" and "we're shut on Mondays" are two different sentences to a
    // customer, so the reason travels with the flag rather than being inferred.
    await withLocation(loc.id, (tx) => tx.insert(orderPauses).values({
      locationId: loc.id, until: new Date(Date.now() + 30 * 60_000),
    }))
    expect((await storefrontView(loc.id)).open).toEqual({ open: false, reason: 'paused' })
  })

  it('publishes a null connected account for a restaurant still onboarding', async () => {
    // Null is the normal state of a restaurant we have just signed, and it is what
    // the checkout turns into "pay at pickup is the only option" — one screen before
    // `POST /api/orders` would have to refuse the card with a 503.
    const loc = await storefront()
    expect((await storefrontView(loc.id)).location.stripeAccountId).toBeNull()
  })

  it('reports a restaurant that is simply shut, with its menu intact', async () => {
    // No business hours at all: closed, but still browsable. A customer reading
    // tomorrow's dinner at midnight is the commonest visit a restaurant site gets.
    const loc = await seedLocationWithMenu()
    await buildMenuSnapshot(loc.id)

    const view = await storefrontView(loc.id)
    expect(view.open).toEqual({ open: false, reason: 'closed_hours' })
    expect(view.categories[0].items.length).toBeGreaterThan(0)
  })

  it('refuses a location that has never pinned a menu — and pins nothing itself', async () => {
    // **Read-only, and this is the test that holds it that way.** A public GET that
    // built a snapshot would let a stranger write a row per request, and would mint
    // menu evidence nobody at the restaurant ever approved.
    const loc = await seedLocationWithMenu()
    await seedBusinessHours(loc.id)

    await expect(storefrontView(loc.id)).rejects.toBeInstanceOf(NoMenuError)
    expect(await snapshots(loc.id)).toHaveLength(0)
  })

  it('shows one restaurant its own menu and never the one next door', async () => {
    const mine = await storefront()
    const theirs = await seedLocationWithMenu()
    await seedBusinessHours(theirs.id)
    await withLocation(theirs.id, (tx) => tx.update(menuItems)
      .set({ name: 'Next Door Curry' }).where(eq(menuItems.id, theirs.items[0].id)))
    await buildMenuSnapshot(theirs.id)

    const view = await storefrontView(mine.id)
    expect(view.categories.flatMap((c) => c.items).map((i) => i.name)).not.toContain('Next Door Curry')
  })

  it('answers inside a caller‑supplied scope, so one request is one transaction', async () => {
    const loc = await storefront()
    const view = await withLocation(loc.id, (tx) => storefrontView(loc.id, tx))
    expect(view.snapshotVersion).toBeGreaterThan(0)
    expect(view.open).toEqual({ open: true })
  })
})
