import { describe, it, expect, beforeEach, vi } from 'vitest'
import { asc, eq } from 'drizzle-orm'
import { orders, orderEvents } from '@/db/schema'
import { withLocation } from '@/repo/scoped'
import { seedLocationWithMenu, seedPaidOrder, seedCardOrder, linkClerkOrg, type SeededMenu } from '@/test/seed'

/**
 * The four buttons on the tablet — Accept, Ready, Complete, Reject — are all this
 * one route, and it is the only way an order's status ever moves by hand.
 *
 * What it must never do is decide for itself which moves are legal. `transition()`
 * owns the machine; this route's job is to carry its refusal out to HTTP as a 422
 * and to write the status and the event it hands back **in one transaction**, which
 * is the whole of "every state change writes an event".
 *
 * The other half is the promise: accepting an order is when the customer is told
 * when to come. `quotedReadyAt` is set here, from the location's own prep time plus
 * whatever the kitchen bumped it by, and a wrong number there is a customer standing
 * at a counter.
 */

const { auth } = vi.hoisted(() => ({ auth: vi.fn() }))
vi.mock('@clerk/nextjs/server', () => ({ auth }))

const { POST } = await import('./orders/[id]/transition/route')

const USER_ID = 'user_test_kitchen'
const MINUTE = 60_000

function signedInAs(orgId: string | null, userId: string | null = USER_ID) {
  auth.mockResolvedValue({ userId, orgId })
}

function post(
  orderId: string,
  locationSlug: string | null,
  body: unknown,
  init: { raw?: string } = {},
): Promise<Response> {
  const url = new URL(`https://serveside.test/api/orders/${orderId}/transition`)
  if (locationSlug !== null) url.searchParams.set('location', locationSlug)
  return POST(
    new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: init.raw ?? JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: orderId }) },
  )
}

async function restaurant(): Promise<SeededMenu & { clerkOrgId: string }> {
  const loc = await seedLocationWithMenu()
  const clerkOrgId = await linkClerkOrg(loc.orgId)
  return { ...loc, clerkOrgId }
}

function readOrder(locationId: string, orderId: string) {
  return withLocation(locationId, async (tx) => {
    const [row] = await tx.select().from(orders).where(eq(orders.id, orderId))
    return row
  })
}

function readEvents(locationId: string, orderId: string) {
  return withLocation(locationId, (tx) => tx.select().from(orderEvents)
    .where(eq(orderEvents.orderId, orderId)).orderBy(asc(orderEvents.at)))
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('POST /api/orders/[id]/transition', () => {
  it('accepts an order, promises a time built from the bump, and records who did it', async () => {
    const loc = await restaurant()
    const { order } = await seedPaidOrder(loc.id)
    signedInAs(loc.clerkOrgId)

    const before = Date.now()
    const res = await post(order.id, loc.slug, { to: 'ACCEPTED', prepBumpMinutes: 10 })
    expect(res.status).toBe(200)
    expect((await res.json()).order.status).toBe('ACCEPTED')

    const row = await readOrder(loc.id, order.id)
    expect(row.status).toBe('ACCEPTED')
    expect(row.acceptedAt).not.toBeNull()

    // The seeded location keeps the schema default of 20 minutes, and the kitchen
    // asked for 10 more: the customer is promised half an hour, not 20 minutes and
    // not 10. Generous window — the assertion is about the arithmetic, not the clock.
    const quoted = new Date(row.quotedReadyAt!).getTime()
    expect(quoted).toBeGreaterThanOrEqual(before + 30 * MINUTE - MINUTE)
    expect(quoted).toBeLessThanOrEqual(Date.now() + 30 * MINUTE + MINUTE)

    const events = await readEvents(loc.id, order.id)
    const moved = events.filter((e) => e.type === 'status_changed')
    expect(moved).toHaveLength(1)
    expect(moved[0].payload).toEqual({ from: 'NEW', to: 'ACCEPTED' })
    // The Clerk user id, not `system`: this is the row that answers "who accepted an
    // order we could not make" six weeks later.
    expect(moved[0].actor).toBe(USER_ID)
  })

  it('quotes the location’s own prep time when nothing is bumped', async () => {
    const loc = await restaurant()
    const { order } = await seedPaidOrder(loc.id)
    signedInAs(loc.clerkOrgId)

    const before = Date.now()
    expect((await post(order.id, loc.slug, { to: 'ACCEPTED' })).status).toBe(200)

    const row = await readOrder(loc.id, order.id)
    const quoted = new Date(row.quotedReadyAt!).getTime()
    expect(quoted).toBeGreaterThanOrEqual(before + 20 * MINUTE - MINUTE)
    expect(quoted).toBeLessThanOrEqual(Date.now() + 20 * MINUTE + MINUTE)
  })

  it('refuses an illegal move with 422, and changes nothing', async () => {
    const loc = await restaurant()
    const { order } = await seedPaidOrder(loc.id)
    signedInAs(loc.clerkOrgId)

    // Nobody hands a customer food that was never cooked. The machine says so, and
    // the route must carry that refusal out rather than inventing an edge.
    const res = await post(order.id, loc.slug, { to: 'COMPLETED' })
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error).toBe('illegal_transition')
    expect(body.from).toBe('NEW')
    expect(body.to).toBe('COMPLETED')

    const row = await readOrder(loc.id, order.id)
    expect(row.status).toBe('NEW')
    // A refused move is not a state change, so it does not get an event either.
    expect((await readEvents(loc.id, order.id)).filter((e) => e.type === 'status_changed')).toHaveLength(0)
  })

  it('walks an order through the kitchen, stamping each moment as it passes', async () => {
    const loc = await restaurant()
    const { order } = await seedPaidOrder(loc.id)
    signedInAs(loc.clerkOrgId)

    for (const to of ['ACCEPTED', 'IN_KITCHEN', 'READY', 'COMPLETED']) {
      expect((await post(order.id, loc.slug, { to })).status, to).toBe(200)
    }

    const row = await readOrder(loc.id, order.id)
    expect(row.status).toBe('COMPLETED')
    expect(row.acceptedAt).not.toBeNull()
    expect(row.readyAt).not.toBeNull()
    expect(row.completedAt).not.toBeNull()
    expect((await readEvents(loc.id, order.id)).filter((e) => e.type === 'status_changed')).toHaveLength(4)
  })

  it('rejects an order, which is a status and an event and nothing else', async () => {
    const loc = await restaurant()
    const { order } = await seedPaidOrder(loc.id)
    signedInAs(loc.clerkOrgId)

    expect((await post(order.id, loc.slug, { to: 'REJECTED' })).status).toBe(200)
    const row = await readOrder(loc.id, order.id)
    expect(row.status).toBe('REJECTED')
    const [moved] = (await readEvents(loc.id, order.id)).filter((e) => e.type === 'status_changed')
    expect(moved.payload).toEqual({ from: 'NEW', to: 'REJECTED' })
  })

  it('records why an order was cancelled, because a cancellation with no reason is a support ticket', async () => {
    const loc = await restaurant()
    const { order } = await seedPaidOrder(loc.id)
    signedInAs(loc.clerkOrgId)

    expect((await post(order.id, loc.slug, { to: 'CANCELED', reason: 'Kitchen closed early' })).status).toBe(200)
    const row = await readOrder(loc.id, order.id)
    expect(row.status).toBe('CANCELED')
    expect(row.canceledAt).not.toBeNull()
    expect(row.cancelReason).toBe('Kitchen closed early')
  })

  it('will not let a tablet push an order that has not been paid for into the kitchen', async () => {
    const loc = await restaurant()
    const { order } = await seedCardOrder(loc.id)
    signedInAs(loc.clerkOrgId)

    // `PENDING_PAYMENT → NEW` is a legal edge — for the Stripe webhook, which flips
    // status, payment status and the quoted time together because it is the only
    // thing that knows the money landed. Done from a tablet it would put unpaid food
    // on a pass and leave the row in a state the webhook no longer recognises as its
    // own, so the real payment would later flip nothing.
    const res = await post(order.id, loc.slug, { to: 'NEW' })
    expect(res.status).toBe(422)
    expect((await res.json()).error).toBe('not_on_the_board')

    const row = await readOrder(loc.id, order.id)
    expect(row.status).toBe('PENDING_PAYMENT')
    expect(row.paymentStatus).toBe('REQUIRES_PAYMENT')
    expect((await readEvents(loc.id, order.id)).filter((e) => e.type === 'status_changed')).toHaveLength(0)
  })

  it('refuses a session whose org maps to a different restaurant, and moves nothing', async () => {
    const mine = await restaurant()
    const theirs = await restaurant()
    const { order } = await seedPaidOrder(mine.id)
    signedInAs(theirs.clerkOrgId)

    const res = await post(order.id, mine.slug, { to: 'ACCEPTED' })
    expect(res.status).toBe(403)
    expect((await readOrder(mine.id, order.id)).status).toBe('NEW')
  })

  it('answers 401 when nobody is signed in', async () => {
    const loc = await restaurant()
    const { order } = await seedPaidOrder(loc.id)
    signedInAs(null, null)

    expect((await post(order.id, loc.slug, { to: 'ACCEPTED' })).status).toBe(401)
    expect((await readOrder(loc.id, order.id)).status).toBe('NEW')
  })

  it('answers 404 for an order sitting in a different location of the same group', async () => {
    const mine = await restaurant()
    const other = await seedLocationWithMenu({ orgId: mine.orgId })
    const { order } = await seedPaidOrder(other.id)
    signedInAs(mine.clerkOrgId)

    // Same org, so the session is authorized — but the scope is the named location
    // and the order is not in it. RLS filters rather than raising, so the order
    // simply is not there, which is the right answer and not a 500.
    const res = await post(order.id, mine.slug, { to: 'ACCEPTED' })
    expect(res.status).toBe(404)
    expect((await readOrder(other.id, order.id)).status).toBe('NEW')
  })

  it('refuses a body the machine has no name for', async () => {
    const loc = await restaurant()
    const { order } = await seedPaidOrder(loc.id)
    signedInAs(loc.clerkOrgId)

    for (const body of [{ to: 'COOKED' }, { to: 42 }, {}]) {
      const res = await post(order.id, loc.slug, body)
      expect(res.status, JSON.stringify(body)).toBe(422)
      expect((await res.json()).error).toBe('invalid_input')
    }
    expect((await post(order.id, loc.slug, null, { raw: 'not json' })).status).toBe(400)
  })

  it('refuses a prep bump that is not a sane number of minutes', async () => {
    const loc = await restaurant()
    const { order } = await seedPaidOrder(loc.id)
    signedInAs(loc.clerkOrgId)

    // A negative bump promises a time in the past; 'ten' is NaN arithmetic that would
    // store an Invalid Date; a four-hour bump is a fat finger, not a prep estimate.
    // `null` is in the list because that is what a client-side `NaN` arrives as once
    // `JSON.stringify` has been over it — absent is the only legal way to say "none".
    for (const prepBumpMinutes of [-5, 'ten', 7.5, 1000, null]) {
      const res = await post(order.id, loc.slug, { to: 'ACCEPTED', prepBumpMinutes })
      expect(res.status, String(prepBumpMinutes)).toBe(422)
      expect((await res.json()).error).toBe('invalid_input')
    }
    expect((await readOrder(loc.id, order.id)).status).toBe('NEW')
  })

  it('answers 400 when no location is named at all', async () => {
    const loc = await restaurant()
    const { order } = await seedPaidOrder(loc.id)
    signedInAs(loc.clerkOrgId)

    expect((await post(order.id, null, { to: 'ACCEPTED' })).status).toBe(400)
  })
})
