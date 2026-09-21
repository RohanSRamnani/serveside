import { pgTable, uuid, text, integer, bigint, boolean, timestamp, time, primaryKey } from 'drizzle-orm/pg-core'
import { locations } from './tenancy'

// Declared first: menuCategories carries an FK to it.
export const availabilityWindows = pgTable('availability_windows', {
  id: uuid('id').primaryKey().defaultRandom(),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  dow: integer('dow').notNull(),
  startTime: time('start_time').notNull(),
  endTime: time('end_time').notNull(),
})

export const menus = pgTable('menus', {
  id: uuid('id').primaryKey().defaultRandom(),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  name: text('name').notNull(),
  isActive: boolean('is_active').notNull().default(true),
})

export const menuCategories = pgTable('menu_categories', {
  id: uuid('id').primaryKey().defaultRandom(),
  menuId: uuid('menu_id').notNull().references(() => menus.id),
  name: text('name').notNull(),
  sort: integer('sort').notNull().default(0),
  availabilityWindowId: uuid('availability_window_id').references(() => availabilityWindows.id),
})

export const menuItems = pgTable('menu_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  categoryId: uuid('category_id').notNull().references(() => menuCategories.id),
  name: text('name').notNull(),
  description: text('description'),
  basePriceCents: bigint('base_price_cents', { mode: 'number' }).notNull(),
  photoUrl: text('photo_url'),
  sort: integer('sort').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  taxCategory: text('tax_category'),
  tags: text('tags').array(),
  // 86: is86d is the switch, unsnoozeAt the "86 until tomorrow" expiry a nightly job clears.
  is86d: boolean('is_86d').notNull().default(false),
  unsnoozeAt: timestamp('unsnooze_at', { withTimezone: true }),
})

// Location-scoped, not item-scoped: one "Spice Level" group hangs off forty dishes.
export const modifierGroups = pgTable('modifier_groups', {
  id: uuid('id').primaryKey().defaultRandom(),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  name: text('name').notNull(),
  minSelect: integer('min_select').notNull().default(0),
  maxSelect: integer('max_select').notNull().default(1),
  required: boolean('required').notNull().default(false),
})

export const modifierOptions = pgTable('modifier_options', {
  id: uuid('id').primaryKey().defaultRandom(),
  groupId: uuid('group_id').notNull().references(() => modifierGroups.id),
  name: text('name').notNull(),
  priceDeltaCents: bigint('price_delta_cents', { mode: 'number' }).notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  // Running out of a topping is as common as running out of a dish.
  is86d: boolean('is_86d').notNull().default(false),
  unsnoozeAt: timestamp('unsnooze_at', { withTimezone: true }),
})

export const itemModifierGroups = pgTable('item_modifier_groups', {
  itemId: uuid('item_id').notNull().references(() => menuItems.id),
  groupId: uuid('group_id').notNull().references(() => modifierGroups.id),
  sort: integer('sort').notNull().default(0),
  // Null overrides mean "use the group's own min/max".
  minOverride: integer('min_override'),
  maxOverride: integer('max_override'),
}, (t) => [primaryKey({ columns: [t.itemId, t.groupId] })])
