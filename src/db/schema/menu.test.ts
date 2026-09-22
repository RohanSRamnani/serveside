import { describe, it, expect } from 'vitest'
import { menus, menuCategories, menuItems, modifierGroups, modifierOptions, itemModifierGroups, availabilityWindows } from '@/db/schema'
import { seedLocation } from '@/test/seed'
import { withLocation } from '@/repo/scoped'

// Every table here is under RLS, so every write runs inside `withLocation`. A bare
// `db()` insert is not a shortcut — it is refused (42501), because the row would
// have no location context to satisfy the policy's WITH CHECK.
describe('menu schema', () => {
  it('models items with a reusable location-scoped modifier group', async () => {
    const loc = await seedLocation()
    const item = await withLocation(loc.id, async (tx) => {
      const [menu] = await tx.insert(menus).values({ locationId: loc.id, name: 'Dinner', isActive: true }).returning()
      const [cat] = await tx.insert(menuCategories).values({ menuId: menu.id, name: 'Mains', sort: 1 }).returning()
      const [spice] = await tx.insert(modifierGroups).values({ locationId: loc.id, name: 'Spice Level', minSelect: 1, maxSelect: 1, required: true }).returning()
      await tx.insert(modifierOptions).values([
        { groupId: spice.id, name: 'Mild', priceDeltaCents: 0 },
        { groupId: spice.id, name: 'Hot', priceDeltaCents: 0 },
      ])
      const [row] = await tx.insert(menuItems).values({
        categoryId: cat.id, name: 'Butter Chicken', description: 'Tomato, cream, fenugreek.',
        basePriceCents: 1800, sort: 1, tags: ['gluten-free'],
      }).returning()
      await tx.insert(itemModifierGroups).values({ itemId: row.id, groupId: spice.id, sort: 1 })
      return row
    })
    expect(item.basePriceCents).toBe(1800)
    expect(item.is86d).toBe(false)
  })

  it('86s a modifier option until a time, independently of its item', async () => {
    const loc = await seedLocation()
    const until = new Date(Date.now() + 86_400_000)
    const option = await withLocation(loc.id, async (tx) => {
      const [group] = await tx.insert(modifierGroups).values({ locationId: loc.id, name: 'Toppings', minSelect: 0, maxSelect: 3, required: false }).returning()
      const [row] = await tx.insert(modifierOptions).values({
        groupId: group.id, name: 'Burrata', priceDeltaCents: 250, is86d: true, unsnoozeAt: until,
      }).returning()
      return row
    })
    expect(option.priceDeltaCents).toBe(250)
    expect(option.is86d).toBe(true)
    expect(option.unsnoozeAt?.getTime()).toBe(until.getTime())
    expect(option.isActive).toBe(true)
  })

  it('scopes a category to an availability window and overrides a group per item', async () => {
    const loc = await seedLocation()
    const { window, menu, cat, item, link } = await withLocation(loc.id, async (tx) => {
      const [window] = await tx.insert(availabilityWindows).values({
        locationId: loc.id, dow: 5, startTime: '17:00:00', endTime: '22:00:00',
      }).returning()
      const [menu] = await tx.insert(menus).values({ locationId: loc.id, name: 'Late Night' }).returning()
      const [cat] = await tx.insert(menuCategories).values({ menuId: menu.id, name: 'After Five', availabilityWindowId: window.id }).returning()
      const [item] = await tx.insert(menuItems).values({ categoryId: cat.id, name: 'Wings', basePriceCents: 1200, tags: ['spicy', 'contains-dairy'] }).returning()
      const [group] = await tx.insert(modifierGroups).values({ locationId: loc.id, name: 'Sauce', minSelect: 1, maxSelect: 1, required: true }).returning()
      const [link] = await tx.insert(itemModifierGroups).values({ itemId: item.id, groupId: group.id, maxOverride: 2 }).returning()
      return { window, menu, cat, item, link }
    })
    expect(window.startTime).toBe('17:00:00')
    expect(cat.availabilityWindowId).toBe(window.id)
    expect(menu.isActive).toBe(true)
    expect(item.description).toBeNull()
    expect(item.tags).toEqual(['spicy', 'contains-dairy'])
    expect(link.sort).toBe(0)
    expect(link.minOverride).toBeNull()
    expect(link.maxOverride).toBe(2)
  })
})
