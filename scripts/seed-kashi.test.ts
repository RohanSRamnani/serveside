import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { drizzle } from 'drizzle-orm/neon-serverless'
import { Pool, neonConfig } from '@neondatabase/serverless'
import { and, desc, eq } from 'drizzle-orm'
import * as schema from '@/db/schema'
import { businessHours, menus, menuSnapshots, organizations, locations } from '@/db/schema'
import type { MenuSnapshotPayload } from '@/db/schema'
import { db } from '@/db/client'
import { withLocation } from '@/repo/scoped'
import { KASHI, REAL_HOURS, ALWAYS_OPEN_HOURS, centsFrom, seedKashi, type SeedDb, type SeedSummary } from './seed-kashi'

/**
 * The seed is data, and data is what this file is mostly about: a wrong price on a
 * real restaurant's menu is worse than a missing one, so the table is checked for the
 * properties that would make one wrong — prices that are not whole cents, a phone
 * `sendSms` would refuse, a dish naming a category or a modifier group that is not
 * seeded, hours that cannot be open.
 *
 * Then it is run for real, twice, against the `test` branch — as the **owner**, which
 * is the one thing this script does that the application may never do. Twice because
 * re-runnability is the property that makes a seeder safe to point at a live demo
 * database: the second run must re-price the menu, not duplicate it.
 *
 * The assertions read the **snapshot payload** rather than the tables, on purpose.
 * That payload is what an order is quoted from, so "the seed worked" and "the
 * location is orderable" are the same question, and it is the one the ledgered ruling
 * cares about: a menu mutation ends with a snapshot.
 */

if (!neonConfig.webSocketConstructor && typeof globalThis.WebSocket !== 'undefined') {
  neonConfig.webSocketConstructor = globalThis.WebSocket as unknown as typeof neonConfig.webSocketConstructor
}

let pool: Pool
let owner: SeedDb
let first: SeedSummary

beforeAll(async () => {
  // The owner connection, from the env file the suite already loaded. Nothing else in
  // this repo's tests connects as the owner except the one CloudPRNT count — and this
  // is the same exception for the same reason: the assertion is about what the
  // *seeder* did, and the seeder is admin work.
  pool = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL! })
  owner = drizzle(pool, { schema })
  first = await seedKashi(owner)
}, 60_000)

afterAll(async () => {
  await pool.end()
})

/** The newest pinned menu for the seeded location, read as the application reads it. */
async function payload(locationId: string): Promise<{ version: number; payload: MenuSnapshotPayload }> {
  const [row] = await withLocation(locationId, (tx) => tx
    .select({ version: menuSnapshots.version, payload: menuSnapshots.payload })
    .from(menuSnapshots)
    .where(eq(menuSnapshots.locationId, locationId))
    .orderBy(desc(menuSnapshots.version))
    .limit(1))
  return row
}

describe('the Kashi seed data', () => {
  it('is ten items across four categories, with two modifier groups', () => {
    expect(KASHI.items).toHaveLength(10)
    expect(KASHI.modifierGroups).toHaveLength(2)
    expect(new Set(KASHI.items.map((item) => item.category))).toEqual(new Set(KASHI.categories))
  })

  it('prices every dish and every option in whole cents', () => {
    for (const item of KASHI.items) {
      expect(Number.isInteger(centsFrom(item.price)), item.name).toBe(true)
      expect(centsFrom(item.price)).toBeGreaterThan(0)
    }
    for (const group of KASHI.modifierGroups) {
      for (const option of group.options) {
        expect(Number.isInteger(centsFrom(option.price ?? 0)), option.name).toBe(true)
      }
    }
  })

  it('refuses a price that is not a whole number of cents', () => {
    expect(centsFrom(21.99)).toBe(2199)
    expect(() => centsFrom(19.995)).toThrow(/whole number of cents/)
  })

  it('names only categories and modifier groups it seeds', () => {
    const groups = new Set(KASHI.modifierGroups.map((group) => group.name))
    for (const item of KASHI.items) {
      expect(KASHI.categories, item.name).toContain(item.category)
      for (const name of item.groups ?? []) expect(groups, item.name).toContain(name)
    }
  })

  it('carries a location `sendSms` would accept, in the restaurant\'s own zone', () => {
    // The same regex `sendSms` enforces. A number typed as (917) 909-0243 is a Twilio
    // 400 and an owner who is simply never told about an order.
    expect(KASHI.location.phoneE164).toMatch(/^\+[1-9]\d{1,14}$/)
    expect(KASHI.location.timezone).toBe('America/New_York')
    // 8.875% NYC prepared food. Named here so a change to it is a change to a test.
    expect(KASHI.location.taxRateBps).toBe(875)
  })

  it('posts the real weekly grid — 11am weekdays, noon weekends, 10pm nightly', () => {
    expect(REAL_HOURS.map((row) => row.dow)).toEqual([0, 1, 2, 3, 4, 5, 6])
    for (const row of REAL_HOURS) {
      // The CHECK on the table: a range that wraps past midnight is open for no
      // instant at all, and nothing would say why.
      expect(row.closeTime > row.openTime, `dow ${row.dow}`).toBe(true)
      expect(row.closeTime).toBe('22:00:00')
      expect(row.openTime).toBe(row.dow === 0 || row.dow >= 5 ? '12:00:00' : '11:00:00')
    }
  })

  it('keeps the always-open grid as seven full days, and legal Postgres time', () => {
    expect(ALWAYS_OPEN_HOURS).toHaveLength(7)
    for (const row of ALWAYS_OPEN_HOURS) {
      expect(row.openTime).toBe('00:00:00')
      expect(row.closeTime).toBe('24:00:00')
    }
  })
})

describe('seedKashi, against the test branch', () => {
  it('writes one org and one location, with the real tax rate and zone', async () => {
    const orgs = await db().select().from(organizations).where(eq(organizations.slug, KASHI.org.slug))
    expect(orgs).toHaveLength(1)

    const rows = await db().select().from(locations).where(eq(locations.orgId, orgs[0].id))
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(first.locationId)
    expect(rows[0].taxRateBps).toBe(875)
    expect(rows[0].timezone).toBe('America/New_York')
    expect(rows[0].phoneE164).toBe(KASHI.location.phoneE164)
    // Left at the column default rather than guessed at: see the seed.
    expect(rows[0].prepTimeMinutes).toBe(20)
  })

  it('leaves exactly one active menu, which is what makes the location orderable', async () => {
    const active = await withLocation(first.locationId, (tx) => tx
      .select({ id: menus.id }).from(menus)
      .where(and(eq(menus.locationId, first.locationId), eq(menus.isActive, true))))
    expect(active).toHaveLength(1)
    expect(active[0].id).toBe(first.menuId)
  })

  it('posts the seven-row weekly grid', async () => {
    const rows = await withLocation(first.locationId, (tx) => tx
      .select().from(businessHours).where(eq(businessHours.locationId, first.locationId)))
    expect(rows).toHaveLength(7)
    expect(new Set(rows.map((row) => row.dow))).toEqual(new Set([0, 1, 2, 3, 4, 5, 6]))
  })

  it('ends with a snapshot carrying every dish at its menu price', async () => {
    const current = await payload(first.locationId)
    expect(current.version).toBe(first.snapshot.version)

    const items = current.payload.categories.flatMap((category) => category.items)
    expect(current.payload.categories).toHaveLength(KASHI.categories.length)
    expect(items).toHaveLength(KASHI.items.length)

    for (const seeded of KASHI.items) {
      const pinned = items.find((item) => item.name === seeded.name)
      expect(pinned, seeded.name).toBeDefined()
      expect(pinned!.basePriceCents, seeded.name).toBe(centsFrom(seeded.price))
    }
  })

  it('pins the mandatory spice level and the bread add-on onto the mains', async () => {
    const current = await payload(first.locationId)
    const butterChicken = current.payload.categories
      .flatMap((category) => category.items)
      .find((item) => item.name === 'Butter Chicken')

    const spice = butterChicken?.modifierGroups.find((group) => group.name === 'Spice Level')
    expect(spice?.minSelect).toBe(1)
    expect(spice?.maxSelect).toBe(1)
    expect(spice?.required).toBe(true)
    // Free, whichever one is chosen: the dish costs what the menu says.
    expect(spice?.options.map((option) => option.priceDeltaCents)).toEqual([0, 0, 0, 0])

    const naan = butterChicken?.modifierGroups.find((group) => group.name === 'Add Naan')
    expect(naan?.minSelect).toBe(0)
    expect(naan?.maxSelect).toBe(2)
    // Kashi's own bread prices, so a naan costs the same whichever way it is ordered.
    expect(naan?.options.find((option) => option.name === 'Garlic Naan')?.priceDeltaCents).toBe(700)
  })

  it('re-seeds without duplicating anything, and re-pins the menu', async () => {
    const again = await seedKashi(owner)

    expect(again.locationId).toBe(first.locationId)
    expect(again.menuId).toBe(first.menuId)
    expect(again.counts).toEqual(first.counts)
    // A menu mutation ends with a snapshot — even one that changed nothing, because
    // the seeder cannot know that it did not.
    expect(again.snapshot.version).toBe(first.snapshot.version + 1)

    const current = await payload(first.locationId)
    expect(current.payload.categories.flatMap((category) => category.items)).toHaveLength(KASHI.items.length)
  }, 60_000)
})
