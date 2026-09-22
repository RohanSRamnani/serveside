import { describe, it, expect } from 'vitest'
import { db } from '@/db/client'
import { organizations, locations, memberships } from '@/db/schema'
import { and, eq } from 'drizzle-orm'

/** Unique per call — nothing tears the `test` branch down, and both slugs are unique columns. */
function token(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 23505 = unique violation. Drizzle wraps driver errors in `DrizzleQueryError`, so
 * the code is on a `cause` somewhere down the chain — same walk as `isVersionRace`.
 */
function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e != null && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    if ((e as { code?: string }).code === '23505') return true
  }
  return false
}

describe('tenancy schema', () => {
  it('inserts an org with a location and reads it back', async () => {
    const [org] = await db().insert(organizations).values({ name: 'Test Org', slug: `t-${Date.now()}` }).returning()
    const [loc] = await db().insert(locations).values({
      orgId: org.id, name: 'Main', slug: 'main', storefrontSlug: token('main'),
      address: '1 Test St, Brooklyn, NY',
      timezone: 'America/New_York', phoneE164: '+15550000001', taxRatePer100k: 8750,
    }).returning()
    const found = await db().query.locations.findFirst({ where: eq(locations.id, loc.id), with: { org: true } })
    expect(found?.org.name).toBe('Test Org')
    // Parts per 100,000 since 2026-09-21: 8750 is 8.75%. See the column's own note.
    expect(found?.taxRatePer100k).toBe(8750)
  })

  it('lets two orgs share a location slug but never a storefront slug', async () => {
    // **The two slugs are two different keys, and this is the difference.**
    // `locations.slug` is the internal one, unique per org, because two restaurants
    // may both call a location `main` and `requireLocationAccess` resolves the org
    // first. `storefront_slug` is the **public routing key** — a customer has no org
    // to resolve inside, so a shared one would put one restaurant's menu at another's
    // URL and send real food to the wrong kitchen. Postgres refuses it, which is what
    // makes the storefront route's ambiguity branch unreachable rather than merely
    // unlikely.
    const [mine] = await db().insert(organizations).values({ name: 'Mine', slug: token('mine') }).returning()
    const [theirs] = await db().insert(organizations).values({ name: 'Theirs', slug: token('theirs') }).returning()
    // A unique-per-run stand-in for 'kashi' — the real one may already be seeded on
    // the `test` branch, and then the *first* insert would 23505 and prove nothing.
    const shared = token('kashi')
    const row = (orgId: string, slug: string, storefrontSlug: string) => ({
      orgId, name: 'Main', slug, storefrontSlug, address: '1 Test St, Brooklyn, NY',
      timezone: 'America/New_York', phoneE164: '+15550000001', taxRatePer100k: 8750,
    })

    // Same `slug` in two orgs: allowed, and load-bearing — see `locations_org_slug_unique`.
    await db().insert(locations).values(row(mine.id, 'main', token('mine-main')))
    await db().insert(locations).values(row(theirs.id, 'main', shared))

    // The same `storefront_slug`: refused, by the database and not by a code path
    // that could be edited out. `slug` is 'annex' so `(org_id, slug)` is satisfied
    // and the storefront constraint is the only one this insert can break.
    const err = await db().insert(locations).values(row(mine.id, 'annex', shared))
      .then(() => null, (e: unknown) => e)
    expect(err).not.toBeNull()
    expect(isUniqueViolation(err)).toBe(true)
  })

  it('stores a membership with a role and an optional location scope', async () => {
    const [org] = await db().insert(organizations).values({ name: 'Member Org', slug: `m-${Date.now()}` }).returning()
    const userId = `user_${Date.now()}`
    await db().insert(memberships).values({ userId, orgId: org.id, role: 'owner' })
    const [found] = await db().select().from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.orgId, org.id)))
    expect(found.role).toBe('owner')
    expect(found.locationId).toBeNull()
  })
})
