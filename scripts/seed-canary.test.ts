import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { businessHours, locations, menuItems, menus, organizations } from '@/db/schema'
import { withLocation } from '@/repo/scoped'
import { isOpenAt } from '@/domain/hours'
import { seedCanary } from './seed-canary'
import { CANARY_ITEM_PRICE_CENTS, CANARY_LOCATION_PHONE, CANARY_ORG_SLUG } from '@/domain/canary'
import { GET as storefrontGET } from '@/app/api/storefront/[location]/route'

/**
 * The canary location, as `npm run seed:canary` writes it. Everything here is a property
 * something else depends on: the canary can only order from an open location with one
 * orderable item, and the rest of the system can only ignore it because it is flagged.
 *
 * Seeded under a fresh org per test, through the same function the CLI runs — as
 * `app_user`, like every other seeder in `src/test/seed.ts`. The owner connection stays
 * `seed-kashi`'s alone.
 */
let runs = 0
const freshOrg = () => `test-canary-seed-${Date.now()}-${runs++}`

describe('seedCanary', () => {
  it('writes a synthetic, always-open location with one one-cent item and a pinned menu', async () => {
    const orgSlug = freshOrg()
    const seeded = await seedCanary({ orgSlug })

    const [loc] = await db().select().from(locations).where(eq(locations.id, seeded.locationId))
    expect(loc).toMatchObject({
      synthetic: true,
      status: 'active',
      phoneE164: CANARY_LOCATION_PHONE,
      stripeAccountId: null,
    })
    // Fictional and unroutable twice over: area code 555 is never assigned, and
    // 555-01xx is the range reserved for fiction.
    expect(CANARY_LOCATION_PHONE).toMatch(/^\+1555555010\d$/)
    // Nothing a customer could guess, and nothing a customer could reach anyway.
    expect(loc.storefrontSlug).toMatch(/^canary-[0-9a-f]{32}$/)

    // No Clerk org: no kitchen feed can ever open it.
    const [org] = await db().select().from(organizations).where(eq(organizations.id, loc.orgId))
    expect(org).toMatchObject({ slug: orgSlug, clerkOrgId: null })

    const items = await withLocation(seeded.locationId, (tx) => tx.select().from(menuItems))
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ id: seeded.itemId, basePriceCents: CANARY_ITEM_PRICE_CENTS, is86d: false })
    expect(CANARY_ITEM_PRICE_CENTS).toBe(1)

    // Open now, whatever now is — the canary runs around the clock.
    const open = await withLocation(seeded.locationId, (tx) => isOpenAt(seeded.locationId, new Date(), tx))
    expect(open.open).toBe(true)
    expect(seeded.snapshot.version).toBeGreaterThanOrEqual(1)
  })

  it('is safe to run again: same location, same slug, one active menu, a fresh pin', async () => {
    const orgSlug = freshOrg()
    const first = await seedCanary({ orgSlug })
    const second = await seedCanary({ orgSlug })

    expect(second.locationId).toBe(first.locationId)
    expect(second.itemId).toBe(first.itemId)
    expect(second.snapshot.version).toBe(first.snapshot.version + 1)

    const [loc] = await db().select().from(locations).where(eq(locations.id, first.locationId))
    const [again] = await db().select().from(locations).where(eq(locations.id, second.locationId))
    expect(again.storefrontSlug).toBe(loc.storefrontSlug)

    const active = await withLocation(first.locationId, (tx) => tx.select().from(menus).where(eq(menus.isActive, true)))
    expect(active).toHaveLength(1)
    const hours = await withLocation(first.locationId, (tx) => tx.select().from(businessHours))
    expect(hours).toHaveLength(7)
  })

  it('is invisible to the storefront — the ordinary 404, pinned menu and all', async () => {
    // What the seeder writes, asked for the way a customer's phone would ask: its public
    // slug, through the public endpoint. The same empty, uncached 404 as a slug nobody owns.
    const seeded = await seedCanary({ orgSlug: freshOrg() })
    const [loc] = await db().select({ slug: locations.storefrontSlug }).from(locations)
      .where(eq(locations.id, seeded.locationId))

    const res = await storefrontGET(
      new Request(`https://serveside.test/api/storefront/${loc.slug}`),
      { params: Promise.resolve({ location: loc.slug }) },
    )
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('')
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('seeds the production org by default', async () => {
    const seeded = await seedCanary()
    const [loc] = await db().select({ orgId: locations.orgId }).from(locations).where(eq(locations.id, seeded.locationId))
    const [org] = await db().select().from(organizations).where(eq(organizations.id, loc.orgId))
    expect(org.slug).toBe(CANARY_ORG_SLUG)
  })
})
