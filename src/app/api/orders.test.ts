import { describe, it, expect, beforeEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { orders, orderEvents, menus } from '@/db/schema'
import { withLocation } from '@/repo/scoped'
import { seedLocationWithMenu, seedBusinessHours, type SeededMenu } from '@/test/seed'

/**
 * The public write path, and the only route in this plan a stranger can POST to.
 *
 * Two contracts are under test, and neither is cosmetic:
 *
 * - **The error contract.** `createOrder` rejects with the `OrderRejectedError`
 *   family, each carrying a stable `code`. Those are answers a customer can act on —
 *   sold out, closed, pick a spice — and they come back 422 with the code. Anything
 *   else is *our* bug and comes back an opaque 500, because the alternative is
 *   leaking a stack trace and a table name to whoever asked.
 * - **The direct charge.** The intent is created on the restaurant's connected
 *   account, for the order's own total, to the cent.
 */
const { paymentIntentsCreate, constructEvent } = vi.hoisted(() => ({
  paymentIntentsCreate: vi.fn(),
  constructEvent: vi.fn(),
}))

vi.mock('stripe', () => ({
  default: class {
    webhooks = { constructEvent }
    paymentIntents = { create: paymentIntentsCreate }
  },
}))

const { POST } = await import('./orders/route')

/** The seeded menu's own arithmetic: (1800 + 50) × 2 = 3700, tax 875bps → 324, tip 500. */
const TIP_CENTS = 500
const EXPECTED_TOTAL = 4524
const STRIPE_ACCOUNT = 'acct_test_kashi'

function post(body: unknown): Promise<Response> {
  return POST(new Request('https://serveside.test/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

/** A restaurant that can take an order right now, onboarded to Stripe unless told otherwise. */
async function openRestaurant(over: Parameters<typeof seedLocationWithMenu>[0] = {}): Promise<SeededMenu> {
  const loc = await seedLocationWithMenu({ stripeAccountId: STRIPE_ACCOUNT, ...over })
  await seedBusinessHours(loc.id)
  return loc
}

function cartFor(loc: SeededMenu, over: Record<string, unknown> = {}) {
  const butterChicken = loc.items.find((i) => i.name === 'Butter Chicken')!
  const hot = loc.modifierOptions.find((o) => o.name === 'Hot')!
  return {
    locationId: loc.id,
    channel: 'web',
    fulfillment: 'pickup',
    contact: { name: 'Rohan R', phone: '+15551234567', email: 'rohan@example.com' },
    items: [{ menuItemId: butterChicken.id, qty: 2, modifierOptionIds: [hot.id] }],
    tipCents: TIP_CENTS,
    payment: 'card',
    ...over,
  }
}

async function readOrder(locationId: string, orderId: string) {
  return withLocation(locationId, async (tx) => {
    const [row] = await tx.select().from(orders).where(eq(orders.id, orderId))
    return row
  })
}

/**
 * A fresh intent id per test. **Not cosmetic:** `orders.stripe_payment_intent_id` is
 * UNIQUE, the Neon `test` branch is never torn down, and a fixed id here passes on a
 * clean branch and then 23505s on every run after it — a failure that looks like a
 * bug in the route.
 */
let intentCounter = 0
let currentIntentId = ''

beforeEach(() => {
  vi.clearAllMocks()
  currentIntentId = `pi_test_${Date.now()}_${intentCounter++}`
  paymentIntentsCreate.mockResolvedValue({
    id: currentIntentId, client_secret: `${currentIntentId}_secret_abc`,
  })
})

describe('POST /api/orders', () => {
  it('places a card order and opens an intent on the restaurant’s own account', async () => {
    const loc = await openRestaurant()

    const res = await post(cartFor(loc))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.shortCode).toHaveLength(4)
    expect(body.clientSecret).toBe(`${currentIntentId}_secret_abc`)

    const [params, options] = paymentIntentsCreate.mock.calls[0]
    // The whole premise of the product: the charge is created ON the connected
    // account, so the restaurant is merchant of record and funds never touch us.
    expect(options).toEqual({ stripeAccount: STRIPE_ACCOUNT })
    // Verbatim, not recomputed — a second arithmetic path is a second way for the
    // charge and the receipt to disagree.
    expect(params.amount).toBe(EXPECTED_TOTAL)
    expect(params.currency).toBe('usd')
    expect(params.automatic_payment_methods).toEqual({ enabled: true })
    // Both ids, because the webhook has no scope of its own: without `locationId` it
    // cannot open `withLocation` and RLS hides the order from it entirely.
    expect(params.metadata).toEqual({ orderId: body.orderId, locationId: loc.id })

    const order = await readOrder(loc.id, body.orderId)
    expect(order.status).toBe('PENDING_PAYMENT')
    expect(order.paymentStatus).toBe('REQUIRES_PAYMENT')
    expect(order.totalCents).toBe(EXPECTED_TOTAL)
    // Written back, so the webhook can prove the event it is handed is this order's.
    expect(order.stripePaymentIntentId).toBe(currentIntentId)
    // No promise while the customer is still on the payment form — the webhook quotes it.
    expect(order.quotedReadyAt).toBeNull()
  })

  it('takes a pay-at-pickup order without going near Stripe', async () => {
    const loc = await openRestaurant({ stripeAccountId: null })

    const res = await post(cartFor(loc, { payment: 'pay_on_pickup' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.clientSecret).toBeUndefined()
    expect(paymentIntentsCreate).not.toHaveBeenCalled()

    const order = await readOrder(loc.id, body.orderId)
    expect(order.status).toBe('NEW')
    expect(order.paymentStatus).toBe('PAY_ON_PICKUP')
    // Already the kitchen's problem, so it is already promised a time.
    expect(order.quotedReadyAt).not.toBeNull()
  })

  it('answers 422 and the rejection code when the customer can do something about it', async () => {
    const loc = await openRestaurant()
    // Switch the menu off mid-service: the one rejection an owner can cause by accident.
    await withLocation(loc.id, (tx) => tx.update(menus).set({ isActive: false }).where(eq(menus.id, loc.menu.id)))

    const res = await post(cartFor(loc))
    expect(res.status).toBe(422)
    const body = await res.json()
    // The code, not the class name and not a stack: it is the contract a client
    // branches on, and it is stable across refactors of the message.
    expect(body.error).toBe('menu_unavailable')
    expect(typeof body.message).toBe('string')
  })

  it('answers 422 for a malformed cart without touching the database', async () => {
    const loc = await openRestaurant()
    const res = await post(cartFor(loc, { items: [] }))
    expect(res.status).toBe(422)
    expect((await res.json()).error).toBe('invalid_input')
  })

  it('answers 422, not 500, for a body missing the fields the domain dereferences', async () => {
    // `createOrder` validates thoroughly but reads `input.items.length` and
    // `input.contact.name` before it can: a body that parses as JSON and is missing
    // either one throws a TypeError, which this route would map to an opaque 500 — a
    // client-triggerable 500 on the one public write path. Each of these is a shape
    // the domain would have tripped over.
    const loc = await openRestaurant()
    const malformed: Record<string, unknown>[] = [
      { locationId: loc.id, payment: 'card', fulfillment: 'pickup', tipCents: 0, contact: { name: 'A', phone: '+1' } },
      { locationId: loc.id, payment: 'card', fulfillment: 'pickup', tipCents: 0, items: [] },
      { ...cartFor(loc), contact: 'Rohan' },
      { ...cartFor(loc), items: [{ menuItemId: loc.items[0].id, qty: 1 }] },
      { ...cartFor(loc), items: 'butter chicken' },
    ]
    for (const body of malformed) {
      const res = await post(body)
      expect([422, 400], JSON.stringify(body)).toContain(res.status)
      expect((await res.json()).error, JSON.stringify(body)).toBe('invalid_input')
    }
  })

  it('answers 400 for a body that is not JSON at all', async () => {
    const res = await POST(new Request('https://serveside.test/api/orders', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json',
    }))
    expect(res.status).toBe(400)
  })

  it('says cards are unavailable — and cancels the order — when the restaurant has not onboarded', async () => {
    // A location with no connected account cannot take a card, and the order is
    // already written by the time we find out. Leaving it at PENDING_PAYMENT would
    // park a row that can never be paid and can never be cancelled by anyone.
    const loc = await openRestaurant({ stripeAccountId: null })

    const res = await post(cartFor(loc))
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error).toBe('stripe_account_missing')
    expect(paymentIntentsCreate).not.toHaveBeenCalled()

    const [row] = await withLocation(loc.id, (tx) => tx.select().from(orders).where(eq(orders.status, 'CANCELED')))
    expect(row.cancelReason).toMatch(/stripe/i)
    const events = await withLocation(loc.id, (tx) =>
      tx.select().from(orderEvents).where(eq(orderEvents.orderId, row.id)))
    expect(events.map((e) => e.type)).toContain('status_changed')
  })

  it('answers an opaque 500 when Stripe itself fails, and does not leave a payable order behind', async () => {
    const loc = await openRestaurant()
    paymentIntentsCreate.mockRejectedValueOnce(new Error('stripe card_declined internals: acct_secret'))

    const res = await post(cartFor(loc))
    expect(res.status).toBe(500)
    const body = await res.json()
    // Opaque on purpose: a 500 body is the one place a stack trace, a table name or
    // an account id leaks to whoever POSTed.
    expect(JSON.stringify(body)).not.toMatch(/acct_secret|card_declined/)

    const [row] = await withLocation(loc.id, (tx) => tx.select().from(orders).where(eq(orders.status, 'CANCELED')))
    expect(row).toBeDefined()
  })
})
