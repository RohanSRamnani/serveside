import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { GetStepTools } from 'inngest'
import type { inngest as inngestClient } from '@/inngest/client'
import { orders, orderEvents, menus, printJobs } from '@/db/schema'
import { withLocation } from '@/repo/scoped'
import {
  CAP_PHONE, seedLocationWithMenu, seedBusinessHours, seedUnpaidPickupOrders, type SeededMenu,
} from '@/test/seed'
import { MAX_OPEN_UNPAID_ORDERS_PER_PHONE_PER_DAY } from '@/lib/order-limits'

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

/**
 * A **pay-at-pickup order reaches NEW inside this route**, and nothing else will ever
 * announce it — the Stripe webhook only sees card orders. So the fan-out has to be
 * fired from here or the ticket is never rendered, the printer never hears about the
 * order, and the owner is never texted: the order exists, is due in 15 minutes, and
 * the only place it appears is the kitchen tablet, if anyone is watching it.
 *
 * `sendOrderCreated` is mocked at the seam the route calls rather than at the network,
 * and the ticket is then proved by driving the **real** `fanOut` with the ids it was
 * handed. `importOriginal` is load-bearing: the fan-out imports `inngest` from this
 * same module, and a factory exporting only `sendOrderCreated` would take the client
 * away from it.
 */
const { sendOrderCreated, sendSms } = vi.hoisted(() => ({
  sendOrderCreated: vi.fn(),
  sendSms: vi.fn(),
}))
vi.mock('@/inngest/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/inngest/client')>(),
  sendOrderCreated,
}))
vi.mock('@/lib/sms', () => ({ sendSms }))

const { POST } = await import('./orders/route')
const { fanOut } = await import('@/inngest/order-created')

/**
 * The SDK's **real** error classes, reached around the module mock above.
 *
 * `vi.mock('stripe')` replaces the whole module for this file, so a `new
 * Stripe.errors.StripeAPIError(...)` written the ordinary way would be a
 * `TypeError` on `undefined`. `importActual` loads the genuine module beside the
 * mock — which matters, because the failover's whole decision is "is this error one
 * of Stripe's own", and a hand-rolled stand-in would prove nothing about that.
 */
const stripeErrors = (await vi.importActual<typeof import('stripe')>('stripe')).default.errors

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
  sendOrderCreated.mockResolvedValue(['01JEVENTID'])
  sendSms.mockResolvedValue(undefined)
  vi.stubEnv('FEED_URL', 'https://serveside.test/feed')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

/** A `step` that simply runs the work — the fan-out's own tests explain why. */
function plainStep(): GetStepTools<typeof inngestClient> {
  return {
    run: (_id: string, fn: () => Promise<unknown>) => fn(),
  } as unknown as GetStepTools<typeof inngestClient>
}

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
    // **The exact key set, not field-by-field.** Checking the fields we care about
    // individually would stay green while someone added `transfer_data`,
    // `on_behalf_of` or `application_fee_amount` — each of which silently converts
    // this into a destination or separate-charge arrangement, routes the money through
    // our balance, and undoes the entire premise above. This assertion is what makes
    // that a failing test rather than a quiet change of business model.
    expect(Object.keys(params).sort()).toEqual(
      ['amount', 'automatic_payment_methods', 'currency', 'metadata'],
    )
    expect(params).not.toHaveProperty('transfer_data')
    expect(params).not.toHaveProperty('on_behalf_of')
    expect(params).not.toHaveProperty('application_fee_amount')
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

  it('announces a pay-at-pickup order, because nothing else ever will', async () => {
    // The order reaches NEW inside this route and the Stripe webhook — the only other
    // caller of the fan-out — never sees it. Without this the ticket is never rendered,
    // no print job is queued, the owner is never texted, and the stale-order alert has
    // no event to hang off: the order is real, due in fifteen minutes, and visible
    // only on a tablet nobody is looking at.
    const loc = await openRestaurant({ stripeAccountId: null })

    const res = await post(cartFor(loc, { payment: 'pay_on_pickup' }))
    expect(res.status).toBe(200)
    const { orderId, shortCode } = await res.json()

    // Both ids: the worker has no scope of its own, and RLS hides the order from
    // anything that cannot name the location.
    expect(sendOrderCreated).toHaveBeenCalledTimes(1)
    expect(sendOrderCreated).toHaveBeenCalledWith(orderId, loc.id)

    // End to end, with the real fan-out rather than a spy's say-so: the ticket a
    // kitchen prints is the artefact this whole path exists to produce.
    await fanOut({ orderId, locationId: loc.id }, plainStep())
    const [job] = await withLocation(loc.id, (tx) =>
      tx.select().from(printJobs).where(eq(printJobs.orderId, orderId)))
    expect(job).toBeDefined()
    expect(job.status).toBe('queued')
    expect(job.payload).toContain(shortCode)
    expect(sendSms).toHaveBeenCalledWith(loc.phoneE164, expect.stringContaining(shortCode))
  })

  it('does not announce a card order from here — the webhook does that when the money lands', async () => {
    // A PENDING_PAYMENT order is not the kitchen's problem, and a ticket for one is
    // food given away. The gate is the status `createOrder` returned, not the payment
    // mode, so a future payment mode that lands at NEW is announced for free.
    const loc = await openRestaurant()
    const res = await post(cartFor(loc))
    expect(res.status).toBe(200)
    expect(sendOrderCreated).not.toHaveBeenCalled()
  })

  it('still takes the order when the announcement cannot be sent', async () => {
    // The order is already committed at NEW by the time this can fail. Answering 500
    // would tell a customer their dinner did not happen when it did, and the retry is
    // a second dinner — so the failure is logged loudly and the order is confirmed.
    // It is not silent: the order is on the kitchen board either way, because the feed
    // reads `orders`, not `print_jobs`.
    const loc = await openRestaurant({ stripeAccountId: null })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    sendOrderCreated.mockRejectedValueOnce(new Error('inngest is down'))

    try {
      const res = await post(cartFor(loc, { payment: 'pay_on_pickup' }))
      expect(res.status).toBe(200)
      const { orderId } = await res.json()
      expect((await readOrder(loc.id, orderId)).status).toBe('NEW')
      expect(error.mock.calls.flat().join(' ')).toMatch(/inngest is down/)
    } finally {
      error.mockRestore()
    }
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
    // the domain would have tripped over — either a missing container, or (the last
    // three) a value `assertInputShape` never checked and that reached a Postgres
    // enum or a text column unvalidated.
    const loc = await openRestaurant()
    const malformed: Record<string, unknown>[] = [
      { locationId: loc.id, payment: 'card', fulfillment: 'pickup', tipCents: 0, contact: { name: 'A', phone: '+1' } },
      { locationId: loc.id, payment: 'card', fulfillment: 'pickup', tipCents: 0, items: [] },
      { ...cartFor(loc), contact: 'Rohan' },
      { ...cartFor(loc), items: 'butter chicken' },
      // Present but not iterable. Absence is legal (see the test below); a number is
      // not, and it must be a coded 422 rather than a TypeError deeper in.
      { ...cartFor(loc), items: [{ menuItemId: loc.items[0].id, qty: 1, modifierOptionIds: 123 }] },
      // `channel` is a Postgres enum: unchecked, this would burn the full pricing
      // read and 22P02 at the INSERT instead of failing here with a code.
      { ...cartFor(loc), channel: 'carrier-pigeon' },
      // `contact.email` and a line's `notes` are nullable text columns with no
      // shape check of their own — a non-string value must still be a coded 422.
      { ...cartFor(loc), contact: { ...(cartFor(loc).contact as Record<string, unknown>), email: 12345 } },
      { ...cartFor(loc), items: [{ menuItemId: loc.items[0].id, qty: 1, notes: 42 }] },
    ]
    for (const body of malformed) {
      const res = await post(body)
      expect([422, 400], JSON.stringify(body)).toContain(res.status)
      expect((await res.json()).error, JSON.stringify(body)).toBe('invalid_input')
    }
  })

  it('takes a line with no modifierOptionIds at all — the most ordinary cart there is', async () => {
    // Lamb Rogan Josh hangs off no modifier group, so "no modifiers" is not a missing
    // choice, it is the whole truth about the line. Requiring the client to send an
    // empty array for it would make the commonest order shape a validation error.
    const loc = await openRestaurant()
    const lamb = loc.items.find((i) => i.name === 'Lamb Rogan Josh')!

    const res = await post(cartFor(loc, {
      items: [{ menuItemId: lamb.id, qty: 1 }],
      tipCents: 0,
      payment: 'pay_on_pickup',
    }))
    expect(res.status).toBe(200)

    const order = await readOrder(loc.id, (await res.json()).orderId)
    // 2100 + 875bps tax (183.75 → 184, half up) and no tip.
    expect(order.subtotalCents).toBe(2100)
    expect(order.totalCents).toBe(2284)
  })

  it('persists SMS marketing consent, with the moment it was given', async () => {
    // Captured at checkout on day one (Plan 3 migrates it to a `customers` row), and
    // the pair is the point: the boolean is what was agreed to, the timestamp is the
    // evidence of when. Marketing only — the "your order is ready" text is
    // transactional and needs no consent, so nothing in the fan-out reads either one.
    const loc = await openRestaurant({ stripeAccountId: null })

    const res = await post(cartFor(loc, { payment: 'pay_on_pickup', smsMarketingConsent: true }))
    expect(res.status).toBe(200)

    const order = await readOrder(loc.id, (await res.json()).orderId)
    expect(order.smsMarketingConsent).toBe(true)
    expect(order.consentAt).not.toBeNull()
  })

  it('defaults consent to false, and leaves consentAt null, when the box was not ticked', async () => {
    const loc = await openRestaurant({ stripeAccountId: null })

    // Both the explicit `false` a ticked-then-unticked checkbox posts and the absent
    // field an older client sends. They must be the same row.
    for (const body of [
      cartFor(loc, { payment: 'pay_on_pickup', smsMarketingConsent: false }),
      cartFor(loc, { payment: 'pay_on_pickup' }),
    ]) {
      const res = await post(body)
      expect(res.status).toBe(200)
      const order = await readOrder(loc.id, (await res.json()).orderId)
      expect(order.smsMarketingConsent).toBe(false)
      expect(order.consentAt).toBeNull()
    }
  })

  it('answers 422 for a consent flag that is not a boolean', async () => {
    // The structural guard's job: `'false'` is truthy, and a coercion here would opt a
    // customer into marketing they declined. Refused at the boundary, with a code.
    const loc = await openRestaurant({ stripeAccountId: null })
    for (const bad of ['true', 'false', 'on', 1, null]) {
      const res = await post(cartFor(loc, { payment: 'pay_on_pickup', smsMarketingConsent: bad }))
      expect(res.status, JSON.stringify(bad)).toBe(422)
      expect((await res.json()).error, JSON.stringify(bad)).toBe('invalid_input')
    }
  })

  it('answers 422 for a phone that is not E.164', async () => {
    // The web form normalises before it posts, so this is the guard for everything
    // that is not the web form — and for a form that stops normalising.
    const loc = await openRestaurant({ stripeAccountId: null })
    for (const phone of ['5551234567', '(555) 123-4567', '+1']) {
      const res = await post(cartFor(loc, {
        payment: 'pay_on_pickup', contact: { name: 'Rohan R', phone },
      }))
      expect(res.status, phone).toBe(422)
      expect((await res.json()).error, phone).toBe('invalid_input')
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

/**
 * **The storefront keeps taking orders when Stripe is down.**
 *
 * An order is already committed at PENDING_PAYMENT by the time the intent is
 * attempted, and the default behaviour for a failure there is to cancel it — which
 * is right when the order can never be paid, and wrong when the only thing that
 * happened is that Stripe had a bad ten minutes. A restaurant with a full dining
 * room and a website that says "something went wrong on our side" loses the order to
 * the phone, or loses it entirely.
 *
 * So a **Stripe-or-network** failure converts the order to the mode every restaurant
 * can always do: NEW / PAY_ON_PICKUP, with a ready time, announced to the kitchen,
 * and answered 200 with `paidAtPickup: true` so the checkout can say so. The money is
 * collected at the counter, which is what a restaurant did for a hundred years before
 * this product existed.
 *
 * What must **not** happen is the same treatment for a failure that is about this
 * request: a declined card, a bad key, a permission we do not have. Those cancel and
 * answer as before, because converting them would sell food on the strength of our
 * own bug.
 */
describe('POST /api/orders — pay-at-pickup failover when Stripe is down', () => {
  /** Every class the ruling calls an outage, driven through the real route. */
  const outages: Array<[string, () => Error]> = [
    ['a Stripe 5xx (StripeAPIError)', () => new stripeErrors.StripeAPIError({ message: 'api down', statusCode: 503 })],
    ['a connection failure', () => new stripeErrors.StripeConnectionError({ message: 'could not reach stripe' })],
  ]

  for (const [label, makeError] of outages) {
    it(`converts a card order to pay-at-pickup on ${label}`, async () => {
      const loc = await openRestaurant()
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      paymentIntentsCreate.mockRejectedValueOnce(makeError())

      let res: Response
      let logged: string
      try {
        res = await post(cartFor(loc))
        // Read before the restore, which clears the recorded calls with the spy.
        logged = error.mock.calls.flat().join(' ')
      } finally {
        error.mockRestore()
      }
      expect(res.status).toBe(200)
      const body = await res.json()

      // **Never silent.** Until error reporting lands, this log line is the only way we
      // learn that Stripe is down and card orders are being taken at the counter — and
      // it names the order, so each converted one can be found. The raw error belongs
      // here, in our log, and nowhere a customer reads.
      expect(logged).toMatch(/converting it to pay-at-pickup/)
      expect(logged).toContain(body.orderId)

      // The flag is the contract the checkout branches on, and the absent client
      // secret is what keeps it from mounting a Payment Element for an order that has
      // no intent to confirm.
      expect(body.paidAtPickup).toBe(true)
      expect(body.clientSecret).toBeUndefined()
      expect(body.orderId).toEqual(expect.any(String))
      expect(body.shortCode).toHaveLength(4)

      const order = await readOrder(loc.id, body.orderId)
      expect(order.status).toBe('NEW')
      expect(order.paymentStatus).toBe('PAY_ON_PICKUP')
      // The kitchen owns it now, so it is promised a time — the same promise a
      // pay-at-pickup order gets, and the same one the webhook makes when money lands.
      expect(order.quotedReadyAt).not.toBeNull()
      // No intent was ever created, so nothing may claim one: the column is UNIQUE and
      // the webhook proves an event belongs to an order by it.
      expect(order.stripePaymentIntentId).toBeNull()
      // Not cancelled. This is the whole difference from the 500 path.
      expect(order.canceledAt).toBeNull()
      expect(order.cancelReason).toBeNull()

      // The audit row says what happened, in words a customer and a cook can both
      // read. The raw Stripe error is not in it — that belongs in the log.
      const events = await withLocation(loc.id, (tx) =>
        tx.select().from(orderEvents).where(eq(orderEvents.orderId, body.orderId)))
      const moved = events.find((e) => e.type === 'status_changed')
      expect(moved).toBeDefined()
      expect(moved!.payload).toMatchObject({ from: 'PENDING_PAYMENT', to: 'NEW' })
      expect(String((moved!.payload as Record<string, unknown>).reason)).toMatch(/card payment/i)
      expect(JSON.stringify(moved!.payload)).not.toMatch(/StripeAPIError|StripeConnectionError|api down/)

      // Announced exactly as a pay-at-pickup order is, because that is now what it is:
      // without this the ticket is never rendered and the owner is never texted.
      expect(sendOrderCreated).toHaveBeenCalledTimes(1)
      expect(sendOrderCreated).toHaveBeenCalledWith(body.orderId, loc.id)
    })
  }

  it('does not fail over a card error — that is not Stripe being down', async () => {
    // A decline cannot occur at intent creation under `automatic_payment_methods`, and
    // if one ever surfaced here it would still be about a card. The existing contract
    // stands: the order is cancelled, the answer is an opaque 500, and nothing about
    // Stripe's internals reaches the body.
    const loc = await openRestaurant()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    paymentIntentsCreate.mockRejectedValueOnce(new stripeErrors.StripeCardError({
      message: 'Your card was declined: acct_secret', code: 'card_declined', decline_code: 'generic_decline',
    }))

    try {
      const res = await post(cartFor(loc))
      expect(res.status).toBe(500)
      expect(JSON.stringify(await res.json())).not.toMatch(/acct_secret|card_declined/)
      expect(sendOrderCreated).not.toHaveBeenCalled()

      const [row] = await withLocation(loc.id, (tx) => tx.select().from(orders).where(eq(orders.status, 'CANCELED')))
      expect(row).toBeDefined()
      expect(row.paymentStatus).toBe('REQUIRES_PAYMENT')
    } finally {
      error.mockRestore()
    }
  })

  it('does not fail over our own misconfiguration', async () => {
    // A bad key or a missing permission is a deployment fault. Converted to
    // pay-at-pickup it would turn every card order on the platform into an unpaid one
    // and nobody would find out until the till was short.
    const loc = await openRestaurant()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    paymentIntentsCreate.mockRejectedValueOnce(
      new stripeErrors.StripeAuthenticationError({ message: 'Invalid API Key provided' }),
    )

    try {
      const res = await post(cartFor(loc))
      expect(res.status).toBe(500)
      const [row] = await withLocation(loc.id, (tx) => tx.select().from(orders).where(eq(orders.status, 'CANCELED')))
      expect(row).toBeDefined()
    } finally {
      error.mockRestore()
    }
  })

  it('does not re-check the unpaid-order cap on a converted order', async () => {
    // The customer asked to pay now. They are paying at the counter because *we* could
    // not reach Stripe, so counting the result against their daily unpaid allowance
    // would charge them for our outage — and would turn a Stripe incident into a
    // second, self-inflicted refusal on the eleventh order of a busy evening.
    const loc = await openRestaurant()
    expect(cartFor(loc).contact.phone).toBe(CAP_PHONE)
    await seedUnpaidPickupOrders(loc.id, MAX_OPEN_UNPAID_ORDERS_PER_PHONE_PER_DAY)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    paymentIntentsCreate.mockRejectedValueOnce(new stripeErrors.StripeAPIError({ message: 'api down' }))

    try {
      const res = await post(cartFor(loc))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.paidAtPickup).toBe(true)
      const order = await readOrder(loc.id, body.orderId)
      expect(order.status).toBe('NEW')
      expect(order.paymentStatus).toBe('PAY_ON_PICKUP')
    } finally {
      error.mockRestore()
    }
  })

  it('answers 422 with the cap’s own sentence when a customer asks for an eleventh', async () => {
    // The other half of the pair: the cap is the customer's to act on, so it travels
    // the ordinary rejection path — a code a client can branch on and a sentence a
    // customer can read. The checkout renders that message verbatim.
    const loc = await openRestaurant({ stripeAccountId: null })
    await seedUnpaidPickupOrders(loc.id, MAX_OPEN_UNPAID_ORDERS_PER_PHONE_PER_DAY)

    const res = await post(cartFor(loc, { payment: 'pay_on_pickup' }))
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error).toBe('unpaid_order_cap')
    expect(body.message).toContain(String(MAX_OPEN_UNPAID_ORDERS_PER_PHONE_PER_DAY))
    expect(body.message).toMatch(/call the restaurant/i)
    // Refused before the INSERT: the ten seeded rows are still the whole story.
    const rows = await withLocation(loc.id, (tx) => tx.select().from(orders))
    expect(rows).toHaveLength(MAX_OPEN_UNPAID_ORDERS_PER_PHONE_PER_DAY)
    expect(sendOrderCreated).not.toHaveBeenCalled()
  })

  it('still answers 200 when the converted order cannot be announced', async () => {
    // Same ruling as the pay-at-pickup branch, and for the same reason: the order is
    // committed at NEW by the time this can fail, so a 500 would tell a customer their
    // dinner did not happen when it did — and their retry is a second dinner.
    const loc = await openRestaurant()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    paymentIntentsCreate.mockRejectedValueOnce(new stripeErrors.StripeConnectionError({ message: 'down' }))
    sendOrderCreated.mockRejectedValueOnce(new Error('inngest is down'))

    try {
      const res = await post(cartFor(loc))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.paidAtPickup).toBe(true)
      expect((await readOrder(loc.id, body.orderId)).status).toBe('NEW')
    } finally {
      error.mockRestore()
    }
  })
})
