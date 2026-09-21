import { describe, it, expect, beforeEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { orders } from '@/db/schema'
import { withLocation } from '@/repo/scoped'
import { seedLocationWithMenu, seedPaidOrder, linkClerkOrg, type SeededMenu } from '@/test/seed'

/**
 * What a kitchen tablet reads, every five seconds, all day.
 *
 * Two things are under test and only one of them is the payload:
 *
 * - **The authorization boundary.** `withLocation` is *scoping*, not authorization —
 *   it will happily open any location it is handed. The thing standing between a
 *   signed-in user and another restaurant's orders is the mapping from the Clerk
 *   session's active org to `organizations.clerk_org_id`, and it has to be checked
 *   **before** the scope opens. The 403 case here is that check; without it every
 *   restaurant on the platform can read every other's order feed by changing a slug.
 * - **The shape of an order card**, because the kitchen cooks from it: the lines,
 *   the modifiers on each line, the line notes and the order note. A dropped
 *   modifier is a wrong dish, and it is silent.
 */

// `auth()` is the whole of Clerk in these tests: the route does one thing with
// Clerk — ask who is signed in and which org is active — so mocking the module
// keeps the suite off the network without faking a session token.
const { auth } = vi.hoisted(() => ({ auth: vi.fn() }))
vi.mock('@clerk/nextjs/server', () => ({ auth }))

const { GET } = await import('./feed/route')

const USER_ID = 'user_test_kitchen'

function signedInAs(orgId: string | null, userId: string | null = USER_ID) {
  auth.mockResolvedValue({ userId, orgId })
}

function get(query: Record<string, string>): Promise<Response> {
  const url = new URL('https://serveside.test/api/feed')
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
  return GET(new Request(url))
}

/** A restaurant whose staff can sign in: a location, its menu, and a Clerk org behind it. */
async function restaurant(): Promise<SeededMenu & { clerkOrgId: string }> {
  const loc = await seedLocationWithMenu()
  const clerkOrgId = await linkClerkOrg(loc.orgId)
  return { ...loc, clerkOrgId }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/feed', () => {
  it('hands the kitchen the order, its lines and every modifier on them', async () => {
    const loc = await restaurant()
    const { order } = await seedPaidOrder(loc.id)
    signedInAs(loc.clerkOrgId)

    const res = await get({ location: loc.slug })
    expect(res.status).toBe(200)
    const body = await res.json()

    // `now` is the server's clock, sent so a tablet can say "4 minutes late"
    // without trusting its own — a kitchen tablet's clock is whatever it was when
    // someone last plugged it in.
    expect(Date.parse(body.now)).not.toBeNaN()

    expect(body.orders).toHaveLength(1)
    const [card] = body.orders
    expect(card.id).toBe(order.id)
    expect(card.shortCode).toBe('K7M2')
    expect(card.status).toBe('NEW')
    expect(card.contactName).toBe('Rohan R')
    expect(card.contactPhone).toBe('+15551234567')
    expect(card.notes).toBe('no cilantro')
    expect(card.totalCents).toBe(4524)
    expect(Date.parse(card.createdAt)).not.toBeNaN()

    expect(card.items).toHaveLength(1)
    expect(card.items[0].nameSnapshot).toBe('Butter Chicken')
    expect(card.items[0].qty).toBe(2)
    // The modifier is the difference between the dish they ordered and a different
    // dish. It is on the card or the kitchen cooks the wrong thing.
    expect(card.items[0].modifiers.map((m: { nameSnapshot: string }) => m.nameSnapshot)).toEqual(['Hot'])
  })

  it('refuses a session whose org maps to a different restaurant', async () => {
    const mine = await restaurant()
    const theirs = await restaurant()
    await seedPaidOrder(mine.id)

    // A real, signed-in user of another restaurant on the platform, asking for this
    // restaurant's feed by slug. This is the attack the route exists to refuse.
    signedInAs(theirs.clerkOrgId)

    const res = await get({ location: mine.slug })
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toBe('forbidden')
    // Nothing about the other restaurant comes back with the refusal.
    expect(JSON.stringify(body)).not.toContain(mine.name)
  })

  it('answers 401 when nobody is signed in', async () => {
    const loc = await restaurant()
    signedInAs(null, null)

    const res = await get({ location: loc.slug })
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('unauthenticated')
  })

  it('answers 403 when the session has no active org', async () => {
    const loc = await restaurant()
    // Signed in, but with a personal account selected rather than a restaurant.
    // There is nothing to map to an org, so there is nothing to authorize.
    signedInAs(null)

    const res = await get({ location: loc.slug })
    expect(res.status).toBe(403)
  })

  it('answers 403 for a slug the signed-in org does not own — including one that does not exist', async () => {
    const loc = await restaurant()
    signedInAs(loc.clerkOrgId)

    const res = await get({ location: 'no-such-restaurant' })
    // Deliberately not a 404: "that slug is not yours" and "that slug is nobody's"
    // must read the same, or the route becomes a way to enumerate the platform's
    // restaurants one guess at a time.
    expect(res.status).toBe(403)
  })

  it('shows a restaurant its own orders and no trace of the one next door', async () => {
    // Both restaurants busy at once, which is the ordinary case and the one where a
    // missing predicate would show. The board must contain exactly A's order.
    //
    // RLS narrows this, and so does the explicit `location_id` in
    // `listActiveWithItems` — the second is pinned independently in
    // `src/repo/repos.test.ts`, by pointing the read at one location inside another's
    // scope, because a test that only opens the right scope would pass with no
    // predicate at all.
    const mine = await restaurant()
    const theirs = await restaurant()
    const ours = await seedPaidOrder(mine.id)
    const nextDoor = await seedPaidOrder(theirs.id)
    signedInAs(mine.clerkOrgId)

    const body = await (await get({ location: mine.slug })).json()
    expect(body.orders.map((o: { id: string }) => o.id)).toEqual([ours.order.id])
    expect(JSON.stringify(body)).not.toContain(nextDoor.order.id)
  })

  it('shows only the orders the kitchen still owns, newest first', async () => {
    const loc = await restaurant()
    const first = await seedPaidOrder(loc.id)
    const second = await seedPaidOrder(loc.id)
    const done = await seedPaidOrder(loc.id)
    await withLocation(loc.id, (tx) => tx.update(orders)
      .set({ status: 'COMPLETED', completedAt: new Date() })
      .where(eq(orders.id, done.order.id)))
    signedInAs(loc.clerkOrgId)

    const body = await (await get({ location: loc.slug })).json()
    // Newest first: the tablet's top card is the order that just landed, and a
    // COMPLETED one is off the board entirely.
    expect(body.orders.map((o: { id: string }) => o.id)).toEqual([second.order.id, first.order.id])
  })

  it('bounds the feed with `since`, inclusive of the instant itself', async () => {
    const loc = await restaurant()
    const older = await seedPaidOrder(loc.id)
    const newer = await seedPaidOrder(loc.id)
    signedInAs(loc.clerkOrgId)

    // The cursor comes from a previous response rather than the test's own clock:
    // `created_at` is the database's `now()`, and the two machines do not agree to
    // the millisecond. Anything that compares one against the other is a flake.
    const all = await (await get({ location: loc.slug })).json()
    const newerCard = all.orders.find((o: { id: string }) => o.id === newer.order.id)

    const body = await (await get({ location: loc.slug, since: newerCard.createdAt })).json()
    expect(body.orders.map((o: { id: string }) => o.id)).toEqual([newer.order.id])
    expect(body.orders.map((o: { id: string }) => o.id)).not.toContain(older.order.id)
  })

  it('answers 400 for a `since` that is not a date, and for no location at all', async () => {
    const loc = await restaurant()
    signedInAs(loc.clerkOrgId)

    expect((await get({ location: loc.slug, since: 'yesterday' })).status).toBe(400)
    expect((await get({})).status).toBe(400)
  })
})
