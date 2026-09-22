/**
 * Seeds Kashi — the pilot restaurant — into a database.
 *
 *   npm run seed:kashi                             # .env.local (the dev branch)
 *   ENV_FILE=.env.test npm run seed:kashi          # the test branch
 *   npm run seed:kashi -- --hours=always-open      # dev-only demo grid, see below
 *
 * **Every dish, price, description and allergen tag is copied verbatim** from the
 * client site's config (`client-sites/src/clients/kashi/config.ts`), which was built
 * from kashiny.com and their live ordering menu. Nothing here is invented, because a
 * wrong price is worse than a missing one. Ten items of their ninety-two, enough to
 * order from; the full menu is a later job.
 *
 * Two things are ours rather than theirs, and both are named where they are defined:
 * the **tax rate** (they publish none — 8.875% is New York City prepared food: 4%
 * state + 4.5% city + 0.375% MCTD, written as 8875 parts per 100,000) and the
 * **modifier groups** (their current vendor offers no modifiers at all; the spice
 * level costs nothing, and the bread add-on's prices are Kashi's own listed bread
 * prices).
 *
 * **It connects as the table owner, on purpose.** Seeding is admin work: it writes
 * menus for a location that does not exist yet, so there is no tenant to scope to
 * when it starts. `withLocation` would refuse this connection outright — it asserts
 * the role cannot bypass RLS, and the owner can — and that assertion is right, for
 * the application. The seeder is the one caller that legitimately sits above tenancy,
 * so it opens its own transaction and sets `app.location_id` itself (see
 * `ownerScope`). Nothing else in this repo may do that. The proof script next door
 * (`spine:proof`) goes through the ordinary `app_user` path precisely so that the
 * exemption stops here.
 *
 * **Re-runnable.** Everything is an upsert keyed on a natural name, so running it
 * again re-prices the menu rather than duplicating it, and the run ends where every
 * menu mutation in this codebase ends: a fresh `menu_snapshots` row. A location that
 * has just been seeded is immediately orderable, with current pinned evidence.
 */
import { drizzle, type NeonDatabase } from 'drizzle-orm/neon-serverless'
import { Pool, neonConfig } from '@neondatabase/serverless'
import { and, eq, inArray, ne, sql } from 'drizzle-orm'
import { config as loadEnv } from 'dotenv'
import { fileURLToPath } from 'node:url'
import * as schema from '@/db/schema'
import {
  organizations, locations, businessHours, menus, menuCategories, menuItems,
  modifierGroups, modifierOptions, itemModifierGroups,
} from '@/db/schema'
import { buildMenuSnapshot } from '@/domain/snapshot'
import type { ScopedTx } from '@/repo/scoped'

// ---------------------------------------------------------------------------
// The restaurant
// ---------------------------------------------------------------------------

/** Dollars as they are written on the menu → integer cents, exactly. */
export function centsFrom(dollars: number): number {
  const cents = Math.round(dollars * 100)
  // The guard is for the day someone adds a `19.995`: a price that cannot be said in
  // cents is a price we would round on a customer's behalf without telling them.
  if (Math.abs(dollars * 100 - cents) > 1e-6) {
    throw new Error(`Price $${dollars} is not a whole number of cents`)
  }
  return cents
}

type ItemSeed = {
  category: string
  name: string
  /** Dollars, written exactly as the source config writes them, so the two can be diffed. */
  price: number
  description: string
  /** Kashi's own allergen and diet tags. */
  tags?: string[]
  /** Modifier groups offered on this dish, by name. */
  groups?: string[]
}

type GroupSeed = {
  name: string
  minSelect: number
  maxSelect: number
  required: boolean
  options: { name: string; price?: number }[]
}

/** The six dishes a spice level and a bread add-on are offered on. */
const MAINS = ['Spice Level', 'Add Naan']

/**
 * Annotated rather than inferred, and that is load-bearing rather than tidy: without
 * it every nested literal is read at its own narrowest type, so an option written
 * without a `price` has no `price` property at all and `option.price` does not
 * compile. The annotation gives the literals a contextual type and still rejects a
 * misspelled field.
 */
type KashiSeed = {
  org: { name: string; slug: string }
  location: {
    name: string
    slug: string
    storefrontSlug: string
    address: string
    timezone: string
    phoneE164: string
    taxRatePer100k: number
  }
  menu: { name: string }
  categories: string[]
  items: ItemSeed[]
  modifierGroups: GroupSeed[]
}

export const KASHI: KashiSeed = {
  org: { name: 'Kashi', slug: 'kashi' },
  location: {
    name: 'Kashi — Downtown Brooklyn',
    /** Internal, unique per org: their street, which is how the staff say which shop. */
    slug: 'livingston',
    /**
     * The customer-facing key — `/order/kashi`, unique platform-wide. The restaurant's
     * name, not their street: it goes on a QR code and in a Google Business "Order
     * Online" link, and `/order/livingston` would read like somebody else's shop.
     *
     * This gap is why `storefront_slug` exists as its own column. A second Kashi
     * location would read `kashi-livingston`.
     */
    storefrontSlug: 'kashi',
    address: '286 Livingston St, Brooklyn, NY 11217',
    timezone: 'America/New_York',
    /** 917-909-0243 on their site; E.164 is the only shape `sendSms` accepts. */
    phoneE164: '+19179090243',
    /**
     * **8.875%**, in parts per 100,000 — New York State 4% + New York City 4.5% +
     * MCTD 0.375%, the rate on prepared food sold in the five boroughs. Kashi
     * publishes no rate of their own, so this is the statutory one and it is the
     * number to check with them first.
     *
     * The unit is the whole reason `locations.tax_rate_per_100k` is not
     * `tax_rate_bps` any more: 8.875% is 887.5 basis points, and an integer column of
     * basis points cannot hold this restaurant's actual tax rate. 8875 here is the
     * one deliberate reprice in the 2026-09-21 re-unit — the migration left every
     * other location's rate exactly where it was.
     */
    taxRatePer100k: 8875,
    // `prep_time_minutes` is deliberately left at the column default (20). It is an
    // operational number only the kitchen can give us, and a guess here would print
    // a promised time on a real ticket.
  },
  menu: { name: 'Online Ordering' },
  categories: ['Small Plates', 'Traditional', 'Signature', 'Breads'],
  /**
   * Ten items, verbatim. Prices in dollars exactly as the source config writes them.
   */
  items: [
    {
      category: 'Small Plates',
      name: 'Sweet Chilli Cauliflower',
      price: 16,
      description: 'Crispy cauliflower florets tossed with spicy chilli sauce.',
      tags: ['Vegetarian', 'Gluten', 'Sesame'],
    },
    {
      category: 'Small Plates',
      name: 'Veg Samosa',
      price: 12,
      description: 'Three pieces, served with green and tamarind chutney.',
      tags: ['Vegetarian', 'Gluten'],
    },
    {
      category: 'Traditional',
      name: 'Butter Chicken',
      price: 24,
      description: 'Tandoori chicken tikka in a creamy tomato gravy.',
      tags: ['Dairy', 'Tree Nuts'],
      groups: MAINS,
    },
    {
      category: 'Traditional',
      name: 'Paneer Butter Masala',
      price: 22,
      description: 'Cottage cheese, onion, tomato, garlic.',
      tags: ['Vegetarian', 'Dairy', 'Tree Nuts'],
      groups: MAINS,
    },
    {
      category: 'Traditional',
      name: 'Dal Kashi Makhani',
      price: 22,
      description: 'Black lentil, kidney beans, homemade butter.',
      tags: ['Vegetarian', 'Dairy'],
      groups: MAINS,
    },
    {
      category: 'Traditional',
      name: 'Yellow Dal Tadka',
      price: 20,
      description: 'Four lentils, onion, tomato, ginger, garlic, asafoetida.',
      tags: ['Vegetarian', 'Dairy'],
      groups: MAINS,
    },
    {
      category: 'Signature',
      name: 'Chicken Dum Biryani',
      price: 26,
      description: 'Spiced basmati rice, chicken, saffron, mint. Served with raita.',
      tags: ['Dairy'],
      groups: MAINS,
    },
    {
      category: 'Signature',
      name: 'Lamb Chops Zarishk Pulao',
      price: 38,
      description: 'Lamb chops, spiced basmati rice, saffron.',
      tags: ['Dairy', 'Gluten'],
      groups: MAINS,
    },
    {
      category: 'Breads',
      name: 'Garlic Naan',
      price: 7,
      description: 'Tandoor-baked, brushed with garlic.',
      tags: ['Vegetarian', 'Dairy', 'Gluten'],
    },
    {
      category: 'Breads',
      name: 'Butter Naan',
      price: 6,
      description: 'Tandoor-baked, finished with butter.',
      tags: ['Vegetarian', 'Dairy', 'Gluten'],
    },
  ],
  /**
   * Two groups, and neither invents a price.
   *
   * **Spice Level** is mandatory and free — every option is a zero delta, so the
   * dish costs what the menu says whichever one is picked. It is here because it is
   * the one question this kitchen is actually asked, and because a `minSelect: 1`
   * group is what proves the order path enforces a mandatory choice.
   *
   * **Add Naan** is optional, at most two, and its deltas are Kashi's own listed
   * bread prices ($7 garlic, $6 butter, $6 plain) — the same numbers as the Breads
   * category, so a naan ordered as an add-on and a naan ordered as a dish cost the
   * same thing.
   */
  modifierGroups: [
    {
      name: 'Spice Level',
      minSelect: 1,
      maxSelect: 1,
      required: true,
      options: [{ name: 'Mild' }, { name: 'Medium' }, { name: 'Hot' }, { name: 'Indian Hot' }],
    },
    {
      name: 'Add Naan',
      minSelect: 0,
      maxSelect: 2,
      required: false,
      options: [
        { name: 'Garlic Naan', price: 7 },
        { name: 'Butter Naan', price: 6 },
        { name: 'Plain Naan', price: 6 },
      ],
    },
  ],
}

/** One row of the weekly grid, in the restaurant's own wall clock. */
export type HoursRow = { dow: number; openTime: string; closeTime: string }

/**
 * Kashi's real hours, from kashiny.com: 11am Monday to Thursday, noon Friday to
 * Sunday, 10pm every night. `dow` is 0 = Sunday, as `Date#getDay` has it.
 */
export const REAL_HOURS: HoursRow[] = [
  { dow: 0, openTime: '12:00:00', closeTime: '22:00:00' },
  { dow: 1, openTime: '11:00:00', closeTime: '22:00:00' },
  { dow: 2, openTime: '11:00:00', closeTime: '22:00:00' },
  { dow: 3, openTime: '11:00:00', closeTime: '22:00:00' },
  { dow: 4, openTime: '11:00:00', closeTime: '22:00:00' },
  { dow: 5, openTime: '12:00:00', closeTime: '22:00:00' },
  { dow: 6, openTime: '12:00:00', closeTime: '22:00:00' },
]

/**
 * Around the clock, seven days — **a development grid, never a restaurant's.**
 *
 * It exists because `createOrder` asks the real `isOpenAt(now)`, so with the real
 * hours above the proof script can only be run between 11am and 10pm New York time,
 * and the suite could only be green during service. `24:00:00` is a legal Postgres
 * `time` and satisfies the `close_time > open_time` CHECK, so the week is seven rows.
 *
 * Opt in with `--hours=always-open`. The default is the truth.
 */
export const ALWAYS_OPEN_HOURS: HoursRow[] = [0, 1, 2, 3, 4, 5, 6].map((dow) => ({
  dow, openTime: '00:00:00', closeTime: '24:00:00',
}))

export type HoursGrid = 'real' | 'always-open'

export function hoursFor(grid: HoursGrid): HoursRow[] {
  return grid === 'always-open' ? ALWAYS_OPEN_HOURS : REAL_HOURS
}

// ---------------------------------------------------------------------------
// The seeder
// ---------------------------------------------------------------------------

export type SeedDb = NeonDatabase<typeof schema>

export type SeedSummary = {
  orgId: string
  locationId: string
  menuId: string
  hours: HoursGrid
  counts: { categories: number; items: number; modifierGroups: number; modifierOptions: number; links: number }
  snapshot: { id: string; version: number }
}

/**
 * Writes the whole restaurant, and ends with a snapshot.
 *
 * The org and the location are written first and outside the transaction below,
 * because everything else needs a location id to scope to. Both are upserts on their
 * natural keys (`organizations.slug`, and `(org_id, slug)` on the location), so a
 * second run re-points the same rows instead of failing on a unique violation.
 */
export async function seedKashi(db: SeedDb, opts: { hours?: HoursGrid } = {}): Promise<SeedSummary> {
  await assertAdminRole(db)
  const grid = opts.hours ?? 'real'

  const [org] = await db.insert(organizations)
    .values({ name: KASHI.org.name, slug: KASHI.org.slug })
    .onConflictDoUpdate({ target: organizations.slug, set: { name: KASHI.org.name } })
    .returning({ id: organizations.id })

  const [location] = await db.insert(locations)
    .values({ orgId: org.id, ...KASHI.location })
    .onConflictDoUpdate({
      target: [locations.orgId, locations.slug],
      // Everything mutable, so the seed stays the source of truth for these fields.
      set: {
        name: KASHI.location.name,
        storefrontSlug: KASHI.location.storefrontSlug,
        address: KASHI.location.address,
        timezone: KASHI.location.timezone,
        phoneE164: KASHI.location.phoneE164,
        taxRatePer100k: KASHI.location.taxRatePer100k,
      },
    })
    .returning({ id: locations.id })

  return ownerScope(db, location.id, async (tx) => {
    const hours = hoursFor(grid)
    // Replaced wholesale rather than merged: the grid is one statement of when the
    // restaurant is open, and a leftover row from a previous shape of it is a lie.
    // Nothing references `business_hours`, so a delete is safe.
    await tx.delete(businessHours).where(eq(businessHours.locationId, location.id))
    await tx.insert(businessHours).values(hours.map((row) => ({ ...row, locationId: location.id })))

    const menuId = await upsertMenu(tx, location.id)
    const categoryIds = await upsertCategories(tx, menuId)
    const { groupIds, optionCount } = await upsertModifierGroups(tx, location.id)
    const { itemIds, links } = await upsertItems(tx, categoryIds, groupIds)

    // **The last act, always.** Menus are pinned evidence in this system: an order
    // quotes the current snapshot rather than the live rows, so a location whose menu
    // has just changed and whose snapshot has not is a location selling last week's
    // prices. Same ruling the 86 route follows.
    const snapshot = await buildMenuSnapshot(location.id, tx)

    return {
      orgId: org.id,
      locationId: location.id,
      menuId,
      hours: grid,
      counts: {
        categories: categoryIds.size,
        items: itemIds.size,
        modifierGroups: groupIds.size,
        modifierOptions: optionCount,
        links,
      },
      snapshot,
    }
  })
}

/**
 * One active menu, and only one.
 *
 * `createOrder` and `buildMenuSnapshot` both refuse a location with two active menus
 * — there is no defensible answer to "what is on sale" — so the seeder deactivates
 * anything else it finds rather than leaving a database it cannot order from.
 */
async function upsertMenu(tx: ScopedTx, locationId: string): Promise<string> {
  const [existing] = await tx.select({ id: menus.id }).from(menus)
    .where(and(eq(menus.locationId, locationId), eq(menus.name, KASHI.menu.name))).limit(1)

  const id = existing?.id ?? (await tx.insert(menus)
    .values({ locationId, name: KASHI.menu.name, isActive: true })
    .returning({ id: menus.id }))[0].id

  if (existing) await tx.update(menus).set({ isActive: true }).where(eq(menus.id, id))
  await tx.update(menus).set({ isActive: false })
    .where(and(eq(menus.locationId, locationId), ne(menus.id, id)))
  return id
}

/** Categories by name, in menu order. */
async function upsertCategories(tx: ScopedTx, menuId: string): Promise<Map<string, string>> {
  const existing = await tx.select({ id: menuCategories.id, name: menuCategories.name })
    .from(menuCategories).where(eq(menuCategories.menuId, menuId))
  const byName = new Map(existing.map((row) => [row.name, row.id]))

  for (const [index, name] of KASHI.categories.entries()) {
    const sort = index + 1
    const id = byName.get(name)
    if (id) {
      await tx.update(menuCategories).set({ sort }).where(eq(menuCategories.id, id))
      continue
    }
    const [row] = await tx.insert(menuCategories).values({ menuId, name, sort })
      .returning({ id: menuCategories.id })
    byName.set(name, row.id)
  }
  return byName
}

/** Groups and their options, by name. Deltas are integer cents. */
async function upsertModifierGroups(
  tx: ScopedTx,
  locationId: string,
): Promise<{ groupIds: Map<string, string>; optionCount: number }> {
  const existing = await tx.select({ id: modifierGroups.id, name: modifierGroups.name })
    .from(modifierGroups).where(eq(modifierGroups.locationId, locationId))
  const groupIds = new Map(existing.map((row) => [row.name, row.id]))
  let optionCount = 0

  for (const group of KASHI.modifierGroups) {
    const shape = { minSelect: group.minSelect, maxSelect: group.maxSelect, required: group.required }
    let id = groupIds.get(group.name)
    if (id) {
      await tx.update(modifierGroups).set(shape).where(eq(modifierGroups.id, id))
    } else {
      const [row] = await tx.insert(modifierGroups).values({ locationId, name: group.name, ...shape })
        .returning({ id: modifierGroups.id })
      id = row.id
      groupIds.set(group.name, id)
    }

    const liveOptions = await tx.select({ id: modifierOptions.id, name: modifierOptions.name })
      .from(modifierOptions).where(eq(modifierOptions.groupId, id))
    const optionIds = new Map(liveOptions.map((row) => [row.name, row.id]))

    for (const option of group.options) {
      const priceDeltaCents = option.price === undefined ? 0 : centsFrom(option.price)
      const optionId = optionIds.get(option.name)
      if (optionId) {
        await tx.update(modifierOptions).set({ priceDeltaCents, isActive: true })
          .where(eq(modifierOptions.id, optionId))
      } else {
        await tx.insert(modifierOptions).values({ groupId: id, name: option.name, priceDeltaCents })
      }
      optionCount++
    }
  }
  return { groupIds, optionCount }
}

/** Items by (category, name), plus the links to their modifier groups. */
async function upsertItems(
  tx: ScopedTx,
  categoryIds: Map<string, string>,
  groupIds: Map<string, string>,
): Promise<{ itemIds: Map<string, string>; links: number }> {
  const existing = categoryIds.size === 0 ? [] : await tx
    .select({ id: menuItems.id, name: menuItems.name })
    .from(menuItems).where(inArray(menuItems.categoryId, [...categoryIds.values()]))
  const itemIds = new Map(existing.map((row) => [row.name, row.id]))
  let links = 0

  // `sort` is per category and follows the order of the table above, which is the
  // order the dishes appear on their own menu.
  const sortByCategory = new Map<string, number>()

  for (const item of KASHI.items) {
    const categoryId = categoryIds.get(item.category)
    if (!categoryId) throw new Error(`seed-kashi: ${item.name} names category ${item.category}, which is not seeded`)
    const sort = (sortByCategory.get(item.category) ?? 0) + 1
    sortByCategory.set(item.category, sort)

    const values = {
      categoryId,
      name: item.name,
      description: item.description,
      basePriceCents: centsFrom(item.price),
      tags: [...(item.tags ?? [])],
      sort,
      isActive: true,
    }

    let itemId = itemIds.get(item.name)
    if (itemId) {
      // `is_86d` is deliberately **not** reset: 86 is the kitchen's switch, and a
      // re-seed that quietly put a sold-out dish back on sale would sell food that
      // does not exist.
      await tx.update(menuItems).set(values).where(eq(menuItems.id, itemId))
    } else {
      const [row] = await tx.insert(menuItems).values(values).returning({ id: menuItems.id })
      itemId = row.id
      itemIds.set(item.name, itemId)
    }

    for (const [index, groupName] of (item.groups ?? []).entries()) {
      const groupId = groupIds.get(groupName)
      if (!groupId) throw new Error(`seed-kashi: ${item.name} names modifier group ${groupName}, which is not seeded`)
      await tx.insert(itemModifierGroups)
        .values({ itemId, groupId, sort: index + 1 })
        // The primary key is (item_id, group_id), so a re-seed re-sorts the link
        // rather than colliding on it.
        .onConflictDoUpdate({
          target: [itemModifierGroups.itemId, itemModifierGroups.groupId],
          set: { sort: index + 1 },
        })
      links++
    }
  }
  return { itemIds, links }
}

/**
 * A transaction scoped the way `withLocation` scopes one, minus the role assertion.
 *
 * The GUC is set even though the owner bypasses every policy that reads it: the
 * seeder should behave identically the day it is pointed at a less privileged role,
 * and a scope that is set is one fewer thing that differs between this path and the
 * application's. What it does **not** do is pretend to be `withLocation` — the
 * assertion that refuses a privileged connection is exactly what a seeder cannot
 * satisfy, and skipping it silently inside the real wrapper would disarm it for
 * everybody.
 */
async function ownerScope<T>(db: SeedDb, locationId: string, fn: (tx: ScopedTx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.location_id', ${locationId}, true)`)
    return fn(tx)
  })
}

/**
 * The mirror image of `withLocation`'s check: seeding needs a role that owns the
 * tables, because it writes location-scoped rows before any policy could pass them.
 * Pointed at `app_user` this script would otherwise fail deep inside the first insert
 * with a bare 42501 and no clue as to which connection string was wrong.
 */
async function assertAdminRole(db: SeedDb): Promise<void> {
  const { rows: [row] } = await db.execute<{ who: string; owns: number; is_super: boolean; bypasses: boolean }>(sql`
    SELECT current_user AS who,
           (SELECT count(*)::int FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user) AS owns,
           (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_super,
           (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypasses`)
  if (Number(row.owns) > 0 || row.is_super || row.bypasses) return
  throw new Error(
    `seed-kashi: connected as "${row.who}", which row-level security binds. Seeding writes a `
    + 'location\'s menu before there is a tenant to scope to, so it needs the owner connection: '
    + 'set MIGRATION_DATABASE_URL in the env file (npm run db:app-user writes it for you).',
  )
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseHours(argv: string[]): HoursGrid {
  const flag = argv.find((arg) => arg.startsWith('--hours='))?.slice('--hours='.length)
  if (flag === undefined || flag === 'real') return 'real'
  if (flag === 'always-open') return 'always-open'
  throw new Error(`seed-kashi: --hours must be "real" or "always-open", got ${JSON.stringify(flag)}`)
}

async function main(): Promise<void> {
  const envFile = process.env.ENV_FILE ?? '.env.local'
  loadEnv({ path: envFile, quiet: true })
  const grid = parseHours(process.argv.slice(2))

  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL
  if (!url) throw new Error(`seed-kashi: ${envFile} has neither MIGRATION_DATABASE_URL nor DATABASE_URL`)

  if (!neonConfig.webSocketConstructor && typeof globalThis.WebSocket !== 'undefined') {
    neonConfig.webSocketConstructor = globalThis.WebSocket as unknown as typeof neonConfig.webSocketConstructor
  }
  const pool = new Pool({ connectionString: url })
  try {
    const summary = await seedKashi(drizzle(pool, { schema }), { hours: grid })
    const { counts } = summary
    console.log(`seed-kashi: ${envFile} — ${KASHI.location.name}`)
    console.log(`  location   ${summary.locationId}`)
    console.log(`  menu       ${counts.items} items in ${counts.categories} categories, `
      + `${counts.modifierGroups} modifier groups (${counts.modifierOptions} options, ${counts.links} links)`)
    console.log(`  hours      ${summary.hours}${grid === 'always-open' ? ' — DEV GRID, not Kashi\'s real hours' : ''}`)
    console.log(`  snapshot   v${summary.snapshot.version} (${summary.snapshot.id})`)
    console.log('  next       npm run spine:proof')
  } finally {
    await pool.end()
  }
}

// Only when run as a script. The tests import this module for its data and its
// seeder, and must not have an env file loaded or a connection opened underneath them.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
