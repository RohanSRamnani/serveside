import { pgTable, uuid, integer, jsonb, timestamp, unique } from 'drizzle-orm/pg-core'
import { locations } from './tenancy'

// The pinned menu, as JSON. Prices and 86 flags are copied in, never joined to
// live menu rows: this payload is what the voice agent reads for the length of a
// call and what settles a price dispute six months later.
export type SnapshotModifierOption = {
  id: string
  name: string
  priceDeltaCents: number
  is86d: boolean
}

export type SnapshotModifierGroup = {
  id: string
  name: string
  /**
   * Effective for THIS item: the item's override if it set one, else the group's own
   * (`item_modifier_groups.minOverride ?? group.minSelect`, and the same for max).
   * An override of 0 is a real value, not "unset".
   */
  minSelect: number
  maxSelect: number
  /**
   * The ruling for validators (Tasks 5, 6, 8): **`minSelect` decides whether a
   * selection is mandatory; `required` never overrides it.** `required` is the
   * group's own flag, which no item can override, so a payload may legitimately say
   * `required: true, minSelect: 0` — an item that opted out of a normally-mandatory
   * group. Enforce min/max; treat `required` as display intent only.
   */
  required: boolean
  options: SnapshotModifierOption[]
}

export type SnapshotItem = {
  id: string
  name: string
  basePriceCents: number
  is86d: boolean
  modifierGroups: SnapshotModifierGroup[]
}

export type SnapshotCategory = {
  id: string
  name: string
  items: SnapshotItem[]
}

export type MenuSnapshotPayload = {
  menuId: string
  categories: SnapshotCategory[]
}

/**
 * Immutable. Rows are only ever inserted — there is no update path anywhere in
 * the codebase, and there must not be one. `(location_id, version)` is unique,
 * which is what actually stops two concurrent builds claiming one version;
 * `buildMenuSnapshot` retries the loser of that race.
 */
export const menuSnapshots = pgTable('menu_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  version: integer('version').notNull(),
  payload: jsonb('payload').$type<MenuSnapshotPayload>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // Also the index for "newest snapshot for this location" — location_id leads it.
  unique('menu_snapshots_location_version_unq').on(t.locationId, t.version),
])

export type MenuSnapshot = typeof menuSnapshots.$inferSelect
