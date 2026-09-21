// Shared test seeders. DB tests run serially against one Neon `test` branch and
// never tear down, so every seed must be collision-proof: unique() suffixes each
// slug/phone. Import these instead of re-inlining a seeder per test file.
import { db } from '@/db/client'
import {
  organizations, locations, menus, menuCategories, menuItems,
  modifierGroups, modifierOptions, itemModifierGroups,
} from '@/db/schema'
import type { Location } from '@/db/schema'

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
  const [menu] = await db().insert(menus).values({
    locationId: loc.id, name: 'Dinner', isActive: true,
  }).returning()
  const [category] = await db().insert(menuCategories).values({
    menuId: menu.id, name: 'Mains', sort: 1,
  }).returning()
  const [modifierGroup] = await db().insert(modifierGroups).values({
    locationId: loc.id, name: 'Spice Level', minSelect: 1, maxSelect: 1, required: true,
  }).returning()
  const options = await db().insert(modifierOptions).values([
    { groupId: modifierGroup.id, name: 'Mild', priceDeltaCents: 0 },
    { groupId: modifierGroup.id, name: 'Hot', priceDeltaCents: 50 },
  ]).returning()
  const items = await db().insert(menuItems).values([
    { categoryId: category.id, name: 'Butter Chicken', description: 'Tomato, cream, fenugreek.', basePriceCents: 1800, sort: 1 },
    { categoryId: category.id, name: 'Lamb Rogan Josh', basePriceCents: 2100, sort: 2 },
  ]).returning()
  await db().insert(itemModifierGroups).values({ itemId: items[0].id, groupId: modifierGroup.id, sort: 1 })
  return { ...loc, menu, category, items, modifierGroup, modifierOptions: options }
}
