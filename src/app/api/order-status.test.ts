import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { orders } from '@/db/schema'
import { withLocation } from '@/repo/scoped'
import { seedLocationWithMenu, seedPaidOrder, seedCardOrder, type SeededMenu } from '@/test/seed'

/**
 * `GET /api/orders/[id]/status?location=<storefront slug>` — public, unauthenticated,
 * and unguessable only because a uuid is. It exists so a customer's own phone can ask
 * "where is my order" without a session, so what it may never do is answer with
 * anything more than the order id already implies: no name, no phone, no line items,
 * no money.
 *
 * **The 404 doctrine is the same one `api/storefront/[location]/route.ts` and
 * `orders/[id]/transition/route.ts` are built around**: an unknown slug, a slug that
 * is somebody else's location, and an id that is not even shaped like one all answer
 * the identical body. Told apart, this route becomes a way to probe which ids and
 * which slugs are real.
 */

const { GET } = await import('./orders/[id]/status/route')

function get(id: string, location: string | null): Promise<Response> {
  const url = new URL(`https://serveside.test/api/orders/${id}/status`)
  if (location !== null) url.searchParams.set('location', location)
  return GET(new Request(url), { params: Promise.resolve({ id }) })
}

async function restaurant(over: Parameters<typeof seedLocationWithMenu>[0] = {}): Promise<SeededMenu> {
  return seedLocationWithMenu(over)
}

describe('GET /api/orders/[id]/status', () => {
  it('answers exactly five keys — no contact field, no line item, no money', async () => {
    const loc = await restaurant()
    const { order } = await seedPaidOrder(loc.id)

    const res = await get(order.id, loc.storefrontSlug)
    expect(res.status).toBe(200)
    const body = await res.json()
    // The exact key set, not field-by-field: checking only the fields this test cares
    // about would stay green while somebody added `contactPhone` or `totalCents` to
    // the select. An order id leaking that is the one thing this response must never do.
    expect(Object.keys(body).sort()).toEqual(
      ['paymentStatus', 'placedAt', 'quotedReadyAt', 'shortCode', 'status'],
    )
    expect(body.shortCode).toBe(order.shortCode)
    expect(body.status).toBe('NEW')
    expect(body.paymentStatus).toBe('PAID')
    expect(typeof body.placedAt).toBe('string')
    expect(new Date(body.placedAt).toISOString()).toBe(body.placedAt)
  })

  it('answers no-store — an order that just changed must never be served stale', async () => {
    const loc = await restaurant()
    const { order } = await seedPaidOrder(loc.id)

    const res = await get(order.id, loc.storefrontSlug)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('is a 404 for an order asked about through a DIFFERENT location’s slug', async () => {
    // The predicate, not just RLS: an order in location A must not resolve just
    // because the caller can name any real slug. Two real restaurants, two real
    // slugs, one order that belongs to only one of them.
    const mine = await restaurant()
    const theirs = await restaurant()
    const { order } = await seedPaidOrder(mine.id)

    const res = await get(order.id, theirs.storefrontSlug)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'order_not_found' })
  })

  it('is the identical 404 for a malformed id', async () => {
    const loc = await restaurant()
    const res = await get('not-a-uuid', loc.storefrontSlug)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'order_not_found' })
  })

  it('is the identical 404 for an unknown slug', async () => {
    const loc = await restaurant()
    const { order } = await seedPaidOrder(loc.id)
    const res = await get(order.id, 'no-such-restaurant-at-all')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'order_not_found' })
  })

  it('is the identical 404 with no location on the query string at all', async () => {
    const loc = await restaurant()
    const { order } = await seedPaidOrder(loc.id)
    const res = await get(order.id, null)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'order_not_found' })
  })

  it('is the identical 404 for a real id at a real restaurant it does not belong to, same as any other miss', async () => {
    // Belt on top of the predicate test above: an id that is a genuine uuid but
    // names no row at all in this location reads exactly like every other miss.
    const loc = await restaurant()
    const res = await get('00000000-0000-4000-8000-000000000000', loc.storefrontSlug)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'order_not_found' })
  })

  it('returns a PENDING_PAYMENT order as such, with no ready time promised yet', async () => {
    // The webhook has not flipped it: no ticket, no kitchen, and — because the clock
    // starts when the money lands, not at checkout — no `quotedReadyAt` either.
    const loc = await restaurant()
    const { order } = await seedCardOrder(loc.id)

    const res = await get(order.id, loc.storefrontSlug)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('PENDING_PAYMENT')
    expect(body.paymentStatus).toBe('REQUIRES_PAYMENT')
    expect(body.quotedReadyAt).toBeNull()
  })

  it('carries a real quotedReadyAt through as an ISO string once one is pinned', async () => {
    // `seedPaidOrder` leaves it null (asserted above and by the PENDING_PAYMENT
    // case); pinning the flip itself belongs to Task 7's webhook tests, so this
    // writes the column directly to prove the route's own `.toISOString()` — not a
    // driver default — is what the customer's phone actually reads.
    const loc = await restaurant()
    const { order } = await seedPaidOrder(loc.id)
    const readyAt = new Date('2026-09-22T23:35:00.000Z')
    await withLocation(loc.id, (tx) => tx.update(orders).set({ quotedReadyAt: readyAt }).where(eq(orders.id, order.id)))

    const res = await get(order.id, loc.storefrontSlug)
    const body = await res.json()
    expect(body.quotedReadyAt).toBe('2026-09-22T23:35:00.000Z')
  })
})
