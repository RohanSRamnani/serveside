import { describe, it, expect } from 'vitest'
import { buildMenuSnapshot, getOrBuildCurrentSnapshot, isVersionRace } from './snapshot'
import { menuSnapshots, menuItems, modifierOptions, menus, itemModifierGroups } from '@/db/schema'
import type { MenuSnapshotPayload } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { seedLocation, seedLocationWithMenu } from '@/test/seed'
import { withLocation } from '@/repo/scoped'

/** Reads a snapshot back the way anything downstream would: scoped to its location. */
async function readSnapshot(locationId: string, snapshotId: string): Promise<MenuSnapshotPayload> {
  const row = await withLocation(locationId, (tx) =>
    tx.query.menuSnapshots.findFirst({ where: eq(menuSnapshots.id, snapshotId) }))
  return row!.payload
}

describe('buildMenuSnapshot', () => {
  it('captures items with prices and increments version', async () => {
    const loc = await seedLocationWithMenu()
    const first = await buildMenuSnapshot(loc.id)
    const second = await buildMenuSnapshot(loc.id)
    expect(second.version).toBe(first.version + 1)
    const payload = await readSnapshot(loc.id, second.id)
    expect(payload.categories[0].items).toHaveLength(2)
    expect(payload.categories[0].items[0].basePriceCents).toBeTypeOf('number')
    expect(payload.categories[0].items[0].modifierGroups[0].options.length).toBeGreaterThan(0)
  })

  it('pins 86 flags and prices for items and options — the dispute evidence', async () => {
    const loc = await seedLocationWithMenu()
    await withLocation(loc.id, async (tx) => {
      await tx.update(menuItems).set({ is86d: true }).where(eq(menuItems.id, loc.items[1].id))
      await tx.update(modifierOptions).set({ is86d: true }).where(eq(modifierOptions.id, loc.modifierOptions[1].id))
    })

    const snap = await buildMenuSnapshot(loc.id)
    const payload = await readSnapshot(loc.id, snap.id)
    expect(payload.menuId).toBe(loc.menu.id)

    const [butterChicken, rogan] = payload.categories[0].items
    expect(butterChicken.basePriceCents).toBe(1800)
    expect(butterChicken.is86d).toBe(false)
    expect(rogan.basePriceCents).toBe(2100)
    expect(rogan.is86d).toBe(true)

    const group = butterChicken.modifierGroups[0]
    expect(group).toMatchObject({ name: 'Spice Level', minSelect: 1, maxSelect: 1, required: true })
    // Options have no sort column, so the payload orders them by name — stable across builds.
    expect(group.options).toEqual([
      { id: loc.modifierOptions[1].id, name: 'Hot', priceDeltaCents: 50, is86d: true },
      { id: loc.modifierOptions[0].id, name: 'Mild', priceDeltaCents: 0, is86d: false },
    ])
  })

  it('pins the limits the item actually enforces, not the group defaults', async () => {
    const loc = await seedLocationWithMenu()
    await withLocation(loc.id, async (tx) => {
      // A third item, so one payload covers all three branches of the override logic.
      const [paneer] = await tx.insert(menuItems).values({
        categoryId: loc.category.id, name: 'Paneer Tikka', basePriceCents: 1600, sort: 3,
      }).returning()
      await tx.insert(itemModifierGroups).values([
        // Both overridden. minOverride: 0 is a real value — `??` keeps it, `||` would not.
        { itemId: loc.items[1].id, groupId: loc.modifierGroup.id, sort: 1, minOverride: 0, maxOverride: 3 },
        // Only max overridden: min must fall back to the group's own.
        { itemId: paneer.id, groupId: loc.modifierGroup.id, sort: 1, maxOverride: 2 },
      ])
    })

    const snap = await buildMenuSnapshot(loc.id)
    const payload = await readSnapshot(loc.id, snap.id)
    const [butterChicken, rogan, tikka] = payload.categories[0].items

    // No overrides: the group's own numbers.
    expect(butterChicken.modifierGroups[0]).toMatchObject({ minSelect: 1, maxSelect: 1 })
    // Partial override: max pinned, min falls back.
    expect(tikka.modifierGroups[0]).toMatchObject({ minSelect: 1, maxSelect: 2 })
    // Both overridden — and this is the case that deleting the override logic would break.
    expect(rogan.modifierGroups[0]).toMatchObject({ minSelect: 0, maxSelect: 3 })

    // The ruling for downstream validators: minSelect decides, `required` does not
    // outrank it. A group flagged required can still be optional on a given item.
    expect(rogan.modifierGroups[0].required).toBe(true)
    expect(rogan.modifierGroups[0].minSelect).toBe(0)
  })

  it('versions per location, not globally', async () => {
    const a = await seedLocationWithMenu()
    const b = await seedLocationWithMenu()
    expect((await buildMenuSnapshot(a.id)).version).toBe(1)
    expect((await buildMenuSnapshot(b.id)).version).toBe(1)
    expect((await buildMenuSnapshot(a.id)).version).toBe(2)
  })

  it('never hands two concurrent builds the same version', async () => {
    const loc = await seedLocationWithMenu()
    const built = await Promise.all([
      buildMenuSnapshot(loc.id), buildMenuSnapshot(loc.id),
      buildMenuSnapshot(loc.id), buildMenuSnapshot(loc.id),
    ])
    const versions = built.map((b) => b.version).sort((x, y) => x - y)
    expect(versions).toEqual([1, 2, 3, 4])
    expect(new Set(built.map((b) => b.id)).size).toBe(4)
  })

  it('leaves off items and options that are no longer on the menu', async () => {
    const loc = await seedLocationWithMenu()
    await withLocation(loc.id, async (tx) => {
      await tx.update(menuItems).set({ isActive: false }).where(eq(menuItems.id, loc.items[1].id))
      await tx.update(modifierOptions).set({ isActive: false }).where(eq(modifierOptions.id, loc.modifierOptions[1].id))
    })

    const snap = await buildMenuSnapshot(loc.id)
    const items = (await readSnapshot(loc.id, snap.id)).categories[0].items
    expect(items.map((i) => i.name)).toEqual(['Butter Chicken'])
    expect(items[0].modifierGroups[0].options.map((o) => o.name)).toEqual(['Mild'])
  })

  it('lets the database reject a duplicate version, and recognises that error as the race', async () => {
    const loc = await seedLocationWithMenu()
    const first = await buildMenuSnapshot(loc.id)
    const payload = await readSnapshot(loc.id, first.id)
    const err = await withLocation(loc.id, (tx) => tx.insert(menuSnapshots)
      .values({ locationId: loc.id, version: first.version, payload }))
      .then(() => null, (e: unknown) => e)
    expect(err).not.toBeNull()
    expect(isVersionRace(err)).toBe(true)
  })

  it('refuses to pin an empty menu', async () => {
    const bare = await seedLocation()
    await expect(buildMenuSnapshot(bare.id)).rejects.toThrow(/no active menu/i)
  })

  it('refuses to guess when a location has two active menus', async () => {
    const loc = await seedLocationWithMenu()
    await withLocation(loc.id, (tx) => tx.insert(menus).values({ locationId: loc.id, name: 'Late Night', isActive: true }))
    await expect(buildMenuSnapshot(loc.id)).rejects.toThrow(/more than one active menu/i)
  })
})

/**
 * What `createOrder` pins to. A rebuild per order would copy the whole menu into a
 * new row for every ticket on a Friday night, and every one of those copies would
 * be identical — so the order path reads the current one and only builds when there
 * is none. Task 13 rebuilds after an 86 change, which is what keeps "current" true.
 */
describe('getOrBuildCurrentSnapshot', () => {
  it('builds one when the location has none', async () => {
    const loc = await seedLocationWithMenu()
    const built = await withLocation(loc.id, (tx) => getOrBuildCurrentSnapshot(loc.id, tx))
    expect(built.version).toBe(1)
    const rows = await withLocation(loc.id, (tx) => tx.select().from(menuSnapshots))
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(built.id)
  })

  it('returns the existing one rather than building a second', async () => {
    const loc = await seedLocationWithMenu()
    const first = await buildMenuSnapshot(loc.id)
    const current = await withLocation(loc.id, (tx) => getOrBuildCurrentSnapshot(loc.id, tx))
    expect(current).toEqual(first)
    expect(await withLocation(loc.id, (tx) => tx.select().from(menuSnapshots))).toHaveLength(1)
  })

  it('returns the newest version, not the oldest', async () => {
    const loc = await seedLocationWithMenu()
    await buildMenuSnapshot(loc.id)
    const newest = await buildMenuSnapshot(loc.id)
    const current = await withLocation(loc.id, (tx) => getOrBuildCurrentSnapshot(loc.id, tx))
    expect(current).toEqual(newest)
    expect(current.version).toBe(2)
  })

  it('answers per location, never with the neighbour\'s menu', async () => {
    const a = await seedLocationWithMenu()
    const b = await seedLocationWithMenu()
    await buildMenuSnapshot(a.id)
    const forB = await withLocation(b.id, (tx) => getOrBuildCurrentSnapshot(b.id, tx))
    const rowsForB = await withLocation(b.id, (tx) => tx.select().from(menuSnapshots))
    expect(rowsForB.map((r) => r.id)).toEqual([forB.id])
    expect(rowsForB[0].payload.menuId).toBe(b.menu.id)
  })
})
