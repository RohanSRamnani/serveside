import { describe, it, expect } from 'vitest'
import { db } from '@/db/client'
import { menus, menuCategories, menuItems, modifierGroups, modifierOptions, itemModifierGroups, availabilityWindows } from '@/db/schema'
import { seedLocation } from '@/test/seed'

describe('menu schema', () => {
  it('models items with a reusable location-scoped modifier group', async () => {
    const loc = await seedLocation()
    const [menu] = await db().insert(menus).values({ locationId: loc.id, name: 'Dinner', isActive: true }).returning()
    const [cat] = await db().insert(menuCategories).values({ menuId: menu.id, name: 'Mains', sort: 1 }).returning()
    const [spice] = await db().insert(modifierGroups).values({ locationId: loc.id, name: 'Spice Level', minSelect: 1, maxSelect: 1, required: true }).returning()
    await db().insert(modifierOptions).values([
      { groupId: spice.id, name: 'Mild', priceDeltaCents: 0 },
      { groupId: spice.id, name: 'Hot', priceDeltaCents: 0 },
    ])
    const [item] = await db().insert(menuItems).values({
      categoryId: cat.id, name: 'Butter Chicken', description: 'Tomato, cream, fenugreek.',
      basePriceCents: 1800, sort: 1, tags: ['gluten-free'],
    }).returning()
    await db().insert(itemModifierGroups).values({ itemId: item.id, groupId: spice.id, sort: 1 })
    expect(item.basePriceCents).toBe(1800)
    expect(item.is86d).toBe(false)
  })

  it('86s a modifier option until a time, independently of its item', async () => {
    const loc = await seedLocation()
    const [group] = await db().insert(modifierGroups).values({ locationId: loc.id, name: 'Toppings', minSelect: 0, maxSelect: 3, required: false }).returning()
    const until = new Date(Date.now() + 86_400_000)
    const [option] = await db().insert(modifierOptions).values({
      groupId: group.id, name: 'Burrata', priceDeltaCents: 250, is86d: true, unsnoozeAt: until,
    }).returning()
    expect(option.priceDeltaCents).toBe(250)
    expect(option.is86d).toBe(true)
    expect(option.unsnoozeAt?.getTime()).toBe(until.getTime())
    expect(option.isActive).toBe(true)
  })

  it('scopes a category to an availability window and overrides a group per item', async () => {
    const loc = await seedLocation()
    const [window] = await db().insert(availabilityWindows).values({
      locationId: loc.id, dow: 5, startTime: '17:00:00', endTime: '22:00:00',
    }).returning()
    const [menu] = await db().insert(menus).values({ locationId: loc.id, name: 'Late Night' }).returning()
    const [cat] = await db().insert(menuCategories).values({ menuId: menu.id, name: 'After Five', availabilityWindowId: window.id }).returning()
    const [item] = await db().insert(menuItems).values({ categoryId: cat.id, name: 'Wings', basePriceCents: 1200, tags: ['spicy', 'contains-dairy'] }).returning()
    const [group] = await db().insert(modifierGroups).values({ locationId: loc.id, name: 'Sauce', minSelect: 1, maxSelect: 1, required: true }).returning()
    const [link] = await db().insert(itemModifierGroups).values({ itemId: item.id, groupId: group.id, maxOverride: 2 }).returning()
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
