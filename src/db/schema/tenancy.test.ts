import { describe, it, expect } from 'vitest'
import { db } from '@/db/client'
import { organizations, locations, memberships } from '@/db/schema'
import { and, eq } from 'drizzle-orm'

describe('tenancy schema', () => {
  it('inserts an org with a location and reads it back', async () => {
    const [org] = await db().insert(organizations).values({ name: 'Test Org', slug: `t-${Date.now()}` }).returning()
    const [loc] = await db().insert(locations).values({
      orgId: org.id, name: 'Main', slug: 'main', address: '1 Test St, Brooklyn, NY',
      timezone: 'America/New_York', phoneE164: '+15550000001', taxRatePer100k: 8750,
    }).returning()
    const found = await db().query.locations.findFirst({ where: eq(locations.id, loc.id), with: { org: true } })
    expect(found?.org.name).toBe('Test Org')
    // Parts per 100,000 since 2026-09-21: 8750 is 8.75%. See the column's own note.
    expect(found?.taxRatePer100k).toBe(8750)
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
