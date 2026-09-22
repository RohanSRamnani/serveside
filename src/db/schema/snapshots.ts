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

/**
 * One dish, as the customer's phone draws it.
 *
 * **The payload carries everything a dish card renders**, because browse reads the
 * snapshot and may not fall back to the live menu tables to fill gaps (see
 * `src/domain/storefront.ts`): a menu that half-renders from a snapshot and half from
 * `menu_items` would have two sources of truth for what a restaurant sells.
 *
 * **`description`, `photoUrl` and `tags` are optional, and the `?` is load-bearing.**
 * `menu_snapshots` rows are **immutable** — insert-only, pinned by orders and voice
 * calls as the evidence a price was quoted from — so the rows written before
 * 2026-09-22 will never grow these fields, and nothing may rewrite them to add them.
 * Declared required, the compiler would promise every reader a value those rows do
 * not have and `item.tags.map(…)` would throw on a six-month-old snapshot. So every
 * reader handles absence (`item.tags ?? []`), and the compiler is what makes it.
 *
 * A *new* row always has all three: `buildMenuSnapshot` writes `null` for empty copy
 * and `[]` for no tags rather than omitting the key, so absence means exactly one
 * thing — "pinned before the dish card had fields to pin".
 */
export type SnapshotItem = {
  id: string
  name: string
  basePriceCents: number
  is86d: boolean
  /** The restaurant's own copy. `null` is "no description"; absent is a pre-2026-09-22 row. */
  description?: string | null
  /** `null` is "no photo", and the card draws its typographic plate instead. */
  photoUrl?: string | null
  /** Normalised to an array on write — the live column is nullable, this is not. */
  tags?: string[]
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
  // Redundant on its own — `id` is already the primary key — and there so that
  // `orders` can point a composite FK at (location_id, id). That FK is what makes
  // "this order pins another restaurant's menu" unrepresentable rather than merely
  // unlikely; a plain FK to `id` would let it through. See `orders.ts`.
  unique('menu_snapshots_location_id_id_unq').on(t.locationId, t.id),
]).enableRLS()

export type MenuSnapshot = typeof menuSnapshots.$inferSelect
