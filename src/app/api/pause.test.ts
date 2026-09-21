import { describe, it, expect, beforeEach, vi } from 'vitest'
import { desc, eq } from 'drizzle-orm'
import { orderPauses } from '@/db/schema'
import { withLocation } from '@/repo/scoped'
import { isOpenAt } from '@/domain/hours'
import { createOrder, LocationClosedError, type CreateOrderResult } from '@/domain/create-order'
import { seedLocationWithMenu, seedBusinessHours, linkClerkOrg, type SeededMenu } from '@/test/seed'

/**
 * "We're slammed — stop taking orders." One tap, with a time on it, and ordering
 * resumes on its own.
 *
 * The thing under test is not the row: it is that `createOrder` refuses, and refuses
 * with `paused` rather than `closed_hours`. Those are two different sentences to a
 * customer — "try again in an hour" against "come back Tuesday" — and the voice agent
 * reads whichever one it is given.
 */
const { auth } = vi.hoisted(() => ({ auth: vi.fn() }))
vi.mock('@clerk/nextjs/server', () => ({ auth }))

const { POST, DELETE } = await import('./pause/route')

const USER_ID = 'user_test_owner'

function signedInAs(orgId: string | null, userId: string | null = USER_ID) {
  auth.mockResolvedValue({ userId, orgId })
}

function call(
  method: 'POST' | 'DELETE',
  slug: string | null,
  body: Record<string, unknown> | string = {},
): Promise<Response> {
  const url = new URL('https://serveside.test/api/pause')
  if (slug !== null) url.searchParams.set('location', slug)
  const handler = method === 'POST' ? POST : DELETE
  return handler(new Request(url, {
    method,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }))
}

/** Open all week, so the only thing that can close this restaurant is the pause. */
async function restaurant() {
  const loc = await seedLocationWithMenu()
  await seedBusinessHours(loc.id)
  const clerkOrgId = await linkClerkOrg(loc.orgId)
  return { ...loc, clerkOrgId }
}

function placeOrder(loc: SeededMenu): Promise<CreateOrderResult> {
  const mild = loc.modifierOptions.find((o) => o.name === 'Mild')!
  return createOrder({
    locationId: loc.id,
    channel: 'web',
    fulfillment: 'pickup',
    contact: { name: 'Rohan R', phone: '+15551234567' },
    items: [{ menuItemId: loc.items[0].id, qty: 1, modifierOptionIds: [mild.id] }],
    tipCents: 0,
    payment: 'pay_on_pickup',
  })
}

/** Every pause this location has ever had, newest first. */
function pauses(locationId: string) {
  return withLocation(locationId, (tx) => tx.select().from(orderPauses)
    .where(eq(orderPauses.locationId, locationId))
    .orderBy(desc(orderPauses.createdAt)))
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('POST /api/pause', () => {
  it('stops orders and says it is a pause, not a closure', async () => {
    const loc = await restaurant()
    signedInAs(loc.clerkOrgId)
    const before = Date.now()

    const res = await call('POST', loc.slug, { minutes: 30, reason: 'slammed' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.paused).toBe(true)
    expect(body.reason).toBe('slammed')

    const until = new Date(body.until).getTime()
    expect(until).toBeGreaterThanOrEqual(before + 30 * 60_000)
    expect(until).toBeLessThan(before + 31 * 60_000)

    // The refusal the customer meets, with the reason that decides what they are told.
    const rejection = await placeOrder(loc).catch((err: unknown) => err)
    expect(rejection).toBeInstanceOf(LocationClosedError)
    expect((rejection as LocationClosedError).reason).toBe('paused')
    expect(await isOpenAt(loc.id, new Date())).toEqual({ open: false, reason: 'paused' })

    // Who paused it is on the row: `order_pauses` is the history of how often a
    // kitchen had to stop, and "the system did it" and "the owner did it" are
    // different facts.
    const [row] = await pauses(loc.id)
    expect(row.createdBy).toBe(USER_ID)
    expect(row.reason).toBe('slammed')
    expect(row.until.getTime()).toBe(until)
  })

  it('pauses one restaurant and not the one next door', async () => {
    const mine = await restaurant()
    const theirs = await restaurant()
    signedInAs(mine.clerkOrgId)

    await call('POST', mine.slug, { minutes: 15 })

    expect(await isOpenAt(theirs.id, new Date())).toEqual({ open: true })
    await expect(placeOrder(theirs)).resolves.toMatchObject({ status: 'NEW' })
    expect(await pauses(theirs.id)).toHaveLength(0)
  })

  it('takes a pause with no reason, because a kitchen mid-rush will not type one', async () => {
    const loc = await restaurant()
    signedInAs(loc.clerkOrgId)

    expect((await call('POST', loc.slug, { minutes: 20 })).status).toBe(200)
    const [row] = await pauses(loc.id)
    expect(row.reason).toBeNull()
  })

  it('refuses a length that is not a real stretch of minutes', async () => {
    const loc = await restaurant()
    signedInAs(loc.clerkOrgId)

    for (const minutes of [0, -30, 7.5, Number.NaN, 1441, '30']) {
      const res = await call('POST', loc.slug, { minutes })
      expect(res.status, `minutes: ${String(minutes)}`).toBe(422)
    }
    expect((await call('POST', loc.slug, {})).status).toBe(422)
    expect((await call('POST', loc.slug, 'not json')).status).toBe(400)

    // Nothing was written, so nothing is paused.
    expect(await pauses(loc.id)).toHaveLength(0)
    expect(await isOpenAt(loc.id, new Date())).toEqual({ open: true })
  })

  it('refuses a session that does not own the restaurant, and one with nobody in it', async () => {
    const mine = await restaurant()
    const theirs = await restaurant()

    signedInAs(theirs.clerkOrgId)
    expect((await call('POST', mine.slug, { minutes: 30 })).status).toBe(403)

    signedInAs(null, null)
    expect((await call('POST', mine.slug, { minutes: 30 })).status).toBe(401)

    signedInAs(mine.clerkOrgId)
    expect((await call('POST', null, { minutes: 30 })).status).toBe(400)

    expect(await pauses(mine.id)).toHaveLength(0)
  })
})

describe('DELETE /api/pause', () => {
  it('resumes early, and the pause stays in the history', async () => {
    // A rush that clears in ten minutes must not leave the doors shut for the other
    // fifty. Resuming shortens the live pause rather than deleting it: how often a
    // kitchen had to stop is worth keeping, and so is who stopped it.
    const loc = await restaurant()
    signedInAs(loc.clerkOrgId)
    await call('POST', loc.slug, { minutes: 60, reason: 'slammed' })
    await expect(placeOrder(loc)).rejects.toBeInstanceOf(LocationClosedError)

    const res = await call('DELETE', loc.slug)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.paused).toBe(false)
    expect(body.resumed).toBe(1)

    await expect(placeOrder(loc)).resolves.toMatchObject({ status: 'NEW' })
    expect(await isOpenAt(loc.id, new Date())).toEqual({ open: true })

    const [row] = await pauses(loc.id)
    expect(row.reason).toBe('slammed')
    expect(row.createdBy).toBe(USER_ID)
    expect(row.until.getTime()).toBeLessThanOrEqual(Date.now())
  })

  it('ends every live pause, not just the newest one', async () => {
    // Two taps in a rush is two rows, and a resume that only shortened the newest
    // would leave the older one holding the doors shut.
    const loc = await restaurant()
    signedInAs(loc.clerkOrgId)
    await call('POST', loc.slug, { minutes: 60 })
    await call('POST', loc.slug, { minutes: 30 })

    expect((await (await call('DELETE', loc.slug)).json()).resumed).toBe(2)
    expect(await isOpenAt(loc.id, new Date())).toEqual({ open: true })
  })

  it('is a no-op on a restaurant that is not paused', async () => {
    const loc = await restaurant()
    signedInAs(loc.clerkOrgId)

    const body = await (await call('DELETE', loc.slug)).json()
    expect(body).toEqual({ paused: false, resumed: 0 })
  })

  it('cannot resume the restaurant next door', async () => {
    const mine = await restaurant()
    const theirs = await restaurant()
    signedInAs(theirs.clerkOrgId)
    await call('POST', theirs.slug, { minutes: 60 })

    signedInAs(mine.clerkOrgId)
    // Their slug is not ours to name, and ours resumes only our own rows.
    expect((await call('DELETE', theirs.slug)).status).toBe(403)
    expect((await (await call('DELETE', mine.slug)).json()).resumed).toBe(0)
    expect(await isOpenAt(theirs.id, new Date())).toEqual({ open: false, reason: 'paused' })
  })
})
