import { describe, it, expect } from 'vitest'
import { buildMenuSnapshot, isVersionRace } from './snapshot'
import { db } from '@/db/client'
import { menuSnapshots, menuItems, modifierOptions, menus } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { seedLocation, seedLocationWithMenu } from '@/test/seed'

describe('buildMenuSnapshot', () => {
  it('captures items with prices and increments version', async () => {
    const loc = await seedLocationWithMenu()
    const first = await buildMenuSnapshot(loc.id)
    const second = await buildMenuSnapshot(loc.id)
    expect(second.version).toBe(first.version + 1)
    const row = await db().query.menuSnapshots.findFirst({ where: eq(menuSnapshots.id, second.id) })
    const payload = row!.payload as any
    expect(payload.categories[0].items).toHaveLength(2)
    expect(payload.categories[0].items[0].basePriceCents).toBeTypeOf('number')
    expect(payload.categories[0].items[0].modifierGroups[0].options.length).toBeGreaterThan(0)
  })

  it('pins 86 flags and prices for items and options — the dispute evidence', async () => {
    const loc = await seedLocationWithMenu()
    await db().update(menuItems).set({ is86d: true }).where(eq(menuItems.id, loc.items[1].id))
    await db().update(modifierOptions).set({ is86d: true }).where(eq(modifierOptions.id, loc.modifierOptions[1].id))

    const snap = await buildMenuSnapshot(loc.id)
    const row = await db().query.menuSnapshots.findFirst({ where: eq(menuSnapshots.id, snap.id) })
    const payload = row!.payload
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
    await db().update(menuItems).set({ isActive: false }).where(eq(menuItems.id, loc.items[1].id))
    await db().update(modifierOptions).set({ isActive: false }).where(eq(modifierOptions.id, loc.modifierOptions[1].id))

    const snap = await buildMenuSnapshot(loc.id)
    const row = await db().query.menuSnapshots.findFirst({ where: eq(menuSnapshots.id, snap.id) })
    const items = row!.payload.categories[0].items
    expect(items.map((i) => i.name)).toEqual(['Butter Chicken'])
    expect(items[0].modifierGroups[0].options.map((o) => o.name)).toEqual(['Mild'])
  })

  it('lets the database reject a duplicate version, and recognises that error as the race', async () => {
    const loc = await seedLocationWithMenu()
    const first = await buildMenuSnapshot(loc.id)
    const row = await db().query.menuSnapshots.findFirst({ where: eq(menuSnapshots.id, first.id) })
    const err = await db().insert(menuSnapshots)
      .values({ locationId: loc.id, version: first.version, payload: row!.payload })
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
    await db().insert(menus).values({ locationId: loc.id, name: 'Late Night', isActive: true })
    await expect(buildMenuSnapshot(loc.id)).rejects.toThrow(/more than one active menu/i)
  })
})
