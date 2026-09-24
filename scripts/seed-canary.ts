/**
 * Seeds the synthetic canary location — the restaurant that exists so the canary
 * (`src/inngest/canary.ts`) has somewhere to place a one-cent order every few minutes.
 *
 *   npm run seed:canary                         # .env.local (the dev branch)
 *   ENV_FILE=.env.test npm run seed:canary      # the test branch
 *
 * Production needs it once, before the canary's first tick: until it exists every run
 * fails with "no synthetic location … run npm run seed:canary", and two of those in a row
 * text `OPS_ALERT_E164` — which is how an unseeded deployment finds out.
 *
 * What it writes, and why each part is shaped the way it is:
 *
 * - **Org `serveside-canary`, with no Clerk org** — so no kitchen feed can ever open it.
 * - **One location, `synthetic = true`** — every owner-facing path skips it and the
 *   storefront answers it with the ordinary 404. Its storefront slug is 32 random hex
 *   characters anyway, kept across re-runs: nothing a customer could guess, for a page
 *   that would not answer them if they did.
 * - **A fictional, unroutable phone** (`CANARY_LOCATION_PHONE`) because the column is NOT
 *   NULL for every location, and no Stripe account — the canary pays at pickup.
 * - **Open around the clock**, because `createOrder` asks `isOpenAt(now)` and the canary
 *   runs at 3am too. Nobody is paged for it at 3am: see `locations.synthetic`.
 * - **One dish at one cent** — the cheapest price that still runs every money path.
 * - **A fresh menu snapshot, last** — orders pin the current snapshot, so a location
 *   whose menu changed without one is not orderable.
 *
 * **It connects as `app_user`, like every seeder in `src/test/seed.ts`** — `db()` for the
 * org and the location (the tenancy root, no RLS), `withLocation` for everything under
 * them. `scripts/seed-kashi.ts` remains the one code path that connects as the owner.
 *
 * **Re-runnable.** Upserts on natural keys (the org slug, `(org_id, slug)` for the
 * location, names for the menu, category and dish), so a second run re-points the same
 * rows, puts the dish back on sale if anything ever 86'd it (there is no kitchen here to
 * own that switch), and pins a new snapshot.
 */
import { config as loadEnv } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { and, eq, ne } from 'drizzle-orm'
import { db } from '@/db/client'
import { organizations, locations, businessHours, menus, menuCategories, menuItems } from '@/db/schema'
import { withLocation, closeScopedPool, type ScopedTx } from '@/repo/scoped'
import { buildMenuSnapshot } from '@/domain/snapshot'
import { CANARY_ORG_SLUG, CANARY_LOCATION_PHONE, CANARY_ITEM_PRICE_CENTS } from '@/domain/canary'

export const CANARY = {
  org: { name: 'Serveside canary' },
  location: {
    name: 'Serveside canary',
    /** Internal, org-scoped. The public slug is random — see the header. */
    slug: 'canary',
    address: 'Synthetic location — not a restaurant',
    /** The pilot's zone, so "the restaurant's day" means what it means at Kashi. */
    timezone: 'America/New_York',
    /** New York City's rate, so the canary's tax runs the same arithmetic the pilot's does. */
    taxRatePer100k: 8875,
  },
  menu: { name: 'Canary' },
  category: 'Canary',
  item: {
    name: 'Canary check',
    description: 'A synthetic one-cent order placed by the canary. Never cooked, never collected.',
  },
} as const

/** Seven rows, midnight to midnight. `24:00:00` is a legal `time` and passes the close > open CHECK. */
const ALWAYS_OPEN = [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow, openTime: '00:00:00', closeTime: '24:00:00' }))

export type CanarySeedSummary = {
  orgId: string
  locationId: string
  itemId: string
  snapshot: { id: string; version: number }
}

export async function seedCanary(opts: { orgSlug?: string } = {}): Promise<CanarySeedSummary> {
  const orgSlug = opts.orgSlug ?? CANARY_ORG_SLUG

  const [org] = await db().insert(organizations)
    .values({ name: CANARY.org.name, slug: orgSlug })
    .onConflictDoUpdate({ target: organizations.slug, set: { name: CANARY.org.name } })
    .returning({ id: organizations.id })

  const [location] = await db().insert(locations)
    .values({
      orgId: org.id,
      ...CANARY.location,
      storefrontSlug: `canary-${randomBytes(16).toString('hex')}`,
      phoneE164: CANARY_LOCATION_PHONE,
      synthetic: true,
      status: 'active',
    })
    .onConflictDoUpdate({
      target: [locations.orgId, locations.slug],
      // Everything but the storefront slug, which keeps the value it was born with.
      set: {
        name: CANARY.location.name,
        address: CANARY.location.address,
        timezone: CANARY.location.timezone,
        taxRatePer100k: CANARY.location.taxRatePer100k,
        phoneE164: CANARY_LOCATION_PHONE,
        synthetic: true,
        status: 'active',
      },
    })
    .returning({ id: locations.id })

  return withLocation(location.id, async (tx) => {
    // Replaced wholesale: the grid is one statement of when the location is open.
    await tx.delete(businessHours).where(eq(businessHours.locationId, location.id))
    await tx.insert(businessHours).values(ALWAYS_OPEN.map((row) => ({ ...row, locationId: location.id })))

    const menuId = await upsertMenu(tx, location.id)
    const categoryId = await upsertCategory(tx, menuId)
    const itemId = await upsertItem(tx, categoryId)

    // The last act, as for every menu mutation in this codebase.
    const snapshot = await buildMenuSnapshot(location.id, tx)
    return { orgId: org.id, locationId: location.id, itemId, snapshot }
  })
}

/** The one active menu; anything else at the location is switched off. */
async function upsertMenu(tx: ScopedTx, locationId: string): Promise<string> {
  const [existing] = await tx.select({ id: menus.id }).from(menus)
    .where(and(eq(menus.locationId, locationId), eq(menus.name, CANARY.menu.name))).limit(1)
  const id = existing?.id ?? (await tx.insert(menus)
    .values({ locationId, name: CANARY.menu.name, isActive: true })
    .returning({ id: menus.id }))[0].id
  if (existing) await tx.update(menus).set({ isActive: true }).where(eq(menus.id, id))
  await tx.update(menus).set({ isActive: false }).where(and(eq(menus.locationId, locationId), ne(menus.id, id)))
  return id
}

async function upsertCategory(tx: ScopedTx, menuId: string): Promise<string> {
  const [existing] = await tx.select({ id: menuCategories.id }).from(menuCategories)
    .where(and(eq(menuCategories.menuId, menuId), eq(menuCategories.name, CANARY.category))).limit(1)
  if (existing) return existing.id
  const [row] = await tx.insert(menuCategories).values({ menuId, name: CANARY.category, sort: 1 })
    .returning({ id: menuCategories.id })
  return row.id
}

async function upsertItem(tx: ScopedTx, categoryId: string): Promise<string> {
  const values = {
    categoryId,
    name: CANARY.item.name,
    description: CANARY.item.description,
    basePriceCents: CANARY_ITEM_PRICE_CENTS,
    tags: [],
    sort: 1,
    isActive: true,
    is86d: false,
    unsnoozeAt: null,
  }
  const [existing] = await tx.select({ id: menuItems.id }).from(menuItems)
    .where(and(eq(menuItems.categoryId, categoryId), eq(menuItems.name, CANARY.item.name))).limit(1)
  if (existing) {
    await tx.update(menuItems).set(values).where(eq(menuItems.id, existing.id))
    return existing.id
  }
  const [row] = await tx.insert(menuItems).values(values).returning({ id: menuItems.id })
  return row.id
}

async function main(): Promise<void> {
  const envFile = process.env.ENV_FILE ?? '.env.local'
  loadEnv({ path: envFile, quiet: true })
  const summary = await seedCanary()
  console.log(
    `seed:canary: ${envFile} — location ${summary.locationId}, one-cent item ${summary.itemId},`
    + ` menu snapshot v${summary.snapshot.version}`,
  )
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
    .then(() => closeScopedPool())
    .catch(async (err: unknown) => {
      console.error('seed:canary failed:', err instanceof Error ? err.message : String(err))
      await closeScopedPool().catch(() => {})
      process.exit(1)
    })
}
