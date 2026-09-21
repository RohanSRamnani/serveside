import { describe, it, expect, beforeEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { orders, orderEvents, webhookEvents } from '@/db/schema'
import { withLocation } from '@/repo/scoped'
import { seedLocationWithMenu, seedCardOrder, seedPaidOrder } from '@/test/seed'

/**
 * The webhook is the only thing in this codebase that takes money off a
 * PENDING_PAYMENT order and hands it to a kitchen, and it runs on input we do not
 * control the delivery of. Two facts drive every test here:
 *
 * 1. **Stripe will deliver the same event twice.** On a retry, on a timeout it never
 *    saw our 200, on a dashboard replay. The idempotency insert is not a nicety; it
 *    is the difference between one ticket and two, and between one `status_changed`
 *    event and an audit trail that lies.
 * 2. **Stripe retries on any 5xx, forever.** So a *legal* state — an order already
 *    flipped, an order the customer cancelled — must come back 200. A 500 there is a
 *    retry storm over something that will never change.
 *
 * The Stripe SDK is mocked whole: no network, and `constructEvent` is the seam that
 * lets a test be a valid or an invalid signature without holding a signing secret.
 */
const { constructEvent, paymentIntentsCreate, sendOrderCreated } = vi.hoisted(() => ({
  constructEvent: vi.fn(),
  paymentIntentsCreate: vi.fn(),
  sendOrderCreated: vi.fn(),
}))

vi.mock('stripe', () => ({
  default: class {
    webhooks = { constructEvent }
    paymentIntents = { create: paymentIntentsCreate }
  },
}))

vi.mock('@/inngest/client', () => ({ sendOrderCreated }))

const { POST } = await import('./webhook/route')

/** How long after payment the kitchen promises the food — deliberately not the 20-minute default. */
const PREP_TIME_MINUTES = 37

let eventCounter = 0

/** A `payment_intent.succeeded` as Stripe delivers it, down to the fields we read. */
function succeededEvent(over: {
  id?: string
  type?: string
  paymentIntentId?: string
  orderId?: string
  locationId?: string
  amount?: number
}) {
  return {
    id: over.id ?? `evt_test_${Date.now()}_${eventCounter++}`,
    type: over.type ?? 'payment_intent.succeeded',
    data: {
      object: {
        id: over.paymentIntentId ?? 'pi_test_1',
        object: 'payment_intent',
        amount: over.amount ?? 4524,
        currency: 'usd',
        status: 'succeeded',
        metadata: { orderId: over.orderId ?? '', locationId: over.locationId ?? '' },
      },
    },
  }
}

/** Posts a raw body with a signature header, exactly as Stripe does. */
function deliver(event: unknown, signature = 't=1,v1=fake'): Promise<Response> {
  const body = JSON.stringify(event)
  // The real handler must read this with `req.text()`, never `req.json()`: the bytes
  // Stripe signed are the bytes that have to be verified, and a parse-then-restringify
  // round trip is not byte-identical.
  return POST(new Request('https://serveside.test/api/stripe/webhook', {
    method: 'POST',
    headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
    body,
  }))
}

async function readOrder(locationId: string, orderId: string) {
  return withLocation(locationId, async (tx) => {
    const [row] = await tx.select().from(orders).where(eq(orders.id, orderId))
    return row
  })
}

async function countEvents(locationId: string, orderId: string): Promise<number> {
  return withLocation(locationId, async (tx) => {
    const rows = await tx.select().from(orderEvents).where(eq(orderEvents.orderId, orderId))
    return rows.length
  })
}

async function eventTypes(locationId: string, orderId: string): Promise<string[]> {
  return withLocation(locationId, async (tx) => {
    const rows = await tx.select().from(orderEvents).where(eq(orderEvents.orderId, orderId))
    return rows.map((r) => r.type)
  })
}

/** `webhook_events` is platform-global, so this read needs no scope — and must find none. */
async function claimRows(externalId: string) {
  return db().select().from(webhookEvents).where(eq(webhookEvents.externalId, externalId))
}

beforeEach(() => {
  vi.clearAllMocks()
  // The default for every test but the bad-signature one: the body parses and the
  // signature is good, so `constructEvent` hands back what was posted.
  constructEvent.mockImplementation((payload: string) => JSON.parse(payload))
  sendOrderCreated.mockResolvedValue(undefined)
})

describe('POST /api/stripe/webhook', () => {
  it('flips a PENDING_PAYMENT order to NEW + PAID, quotes a ready time, and records the move', async () => {
    const loc = await seedLocationWithMenu({ prepTimeMinutes: PREP_TIME_MINUTES })
    const { order } = await seedCardOrder(loc.id)
    expect(order.quotedReadyAt).toBeNull()

    const before = Date.now()
    const event = succeededEvent({
      orderId: order.id, locationId: loc.id, paymentIntentId: order.stripePaymentIntentId!,
    })
    const res = await deliver(event)
    const after = Date.now()

    expect(res.status).toBe(200)

    const flipped = await readOrder(loc.id, order.id)
    expect(flipped.status).toBe('NEW')
    // All three together, because they are one fact: the kitchen owns this order now.
    // A flip that forgets `quotedReadyAt` leaves an order nobody ever promised a time
    // for, which is the number the late-order alert and the customer screen both read.
    expect(flipped.paymentStatus).toBe('PAID')
    expect(flipped.quotedReadyAt).not.toBeNull()
    const quoted = flipped.quotedReadyAt!.getTime()
    expect(quoted).toBeGreaterThanOrEqual(before + PREP_TIME_MINUTES * 60_000)
    expect(quoted).toBeLessThanOrEqual(after + PREP_TIME_MINUTES * 60_000)

    // The machine wrote the move, so the audit trail can answer "when did this become
    // the kitchen's problem, and who said so".
    const types = await eventTypes(loc.id, order.id)
    expect(types).toContain('status_changed')
    const [statusEvent] = await withLocation(loc.id, (tx) =>
      tx.select().from(orderEvents).where(eq(orderEvents.type, 'status_changed')))
    expect(statusEvent.actor).toBe('stripe')
    expect(statusEvent.payload).toMatchObject({ from: 'PENDING_PAYMENT', to: 'NEW' })

    // And the fan-out is asked for exactly once, with both ids: Task 10's worker has
    // no scope of its own and cannot look the location up from a hidden order row.
    expect(sendOrderCreated).toHaveBeenCalledTimes(1)
    expect(sendOrderCreated).toHaveBeenCalledWith(order.id, loc.id)

    // The claim is on file, with the payload, for forensics.
    const claims = await claimRows(event.id)
    expect(claims).toHaveLength(1)
    expect(claims[0].provider).toBe('stripe')
  })

  it('does nothing at all the second time the same event id arrives, and still answers 200', async () => {
    const loc = await seedLocationWithMenu({ prepTimeMinutes: PREP_TIME_MINUTES })
    const { order } = await seedCardOrder(loc.id)
    const event = succeededEvent({
      orderId: order.id, locationId: loc.id, paymentIntentId: order.stripePaymentIntentId!,
    })

    const first = await deliver(event)
    expect(first.status).toBe(200)
    const afterFirst = await readOrder(loc.id, order.id)
    const eventsAfterFirst = await countEvents(loc.id, order.id)

    const second = await deliver(event)
    // 200, not 409: from Stripe's side a duplicate that changes nothing IS success,
    // and anything else puts the event back in the retry queue.
    expect(second.status).toBe(200)
    // Said out loud in the body, because "nothing changed" alone cannot distinguish
    // the claim doing its job from the status check catching it downstream — and the
    // claim is the one that has to work. The test below pins it properly.
    expect(await second.json()).toMatchObject({ duplicate: true })

    const afterSecond = await readOrder(loc.id, order.id)
    // The whole row, not just the status: a second flip would also move
    // `quotedReadyAt` forward by a full prep time and quietly re-promise the customer.
    expect(afterSecond).toEqual(afterFirst)
    expect(await countEvents(loc.id, order.id)).toBe(eventsAfterFirst)
    // One ticket, one SMS. This is the assertion the whole table exists for.
    expect(sendOrderCreated).toHaveBeenCalledTimes(1)
    expect(await claimRows(event.id)).toHaveLength(1)
  })

  it('drops an event id already claimed, even when the order is still sitting there flippable', async () => {
    // The test that makes the claim load-bearing rather than incidental.
    //
    // In the double-delivery case above, the second delivery is *also* stopped by the
    // order no longer being PENDING_PAYMENT — so deleting the idempotency check
    // entirely would not change the outcome, and the test would still pass. Here the
    // order is untouched and would flip if the handler ran, so the only thing that can
    // stop it is the claim.
    //
    // Not a contrivance, either: this is the shape of a redelivery whose 200 was lost
    // in transit, or one another instance has already taken.
    const loc = await seedLocationWithMenu({ prepTimeMinutes: PREP_TIME_MINUTES })
    const { order } = await seedCardOrder(loc.id)
    const event = succeededEvent({
      orderId: order.id, locationId: loc.id, paymentIntentId: order.stripePaymentIntentId!,
    })
    await db().insert(webhookEvents).values({
      provider: 'stripe', externalId: event.id, payload: { note: 'claimed by another instance' },
    })

    const res = await deliver(event)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ duplicate: true })

    const untouched = await readOrder(loc.id, order.id)
    expect(untouched.status).toBe('PENDING_PAYMENT')
    expect(untouched.paymentStatus).toBe('REQUIRES_PAYMENT')
    expect(untouched.quotedReadyAt).toBeNull()
    expect(sendOrderCreated).not.toHaveBeenCalled()
    // And the first claim's payload is left alone — a duplicate never overwrites the
    // record of the delivery that actually ran.
    const [claim] = await claimRows(event.id)
    expect(claim.payload).toEqual({ note: 'claimed by another instance' })
  })

  it('refuses a bad signature with 400, before it has written anything', async () => {
    const loc = await seedLocationWithMenu({ prepTimeMinutes: PREP_TIME_MINUTES })
    const { order } = await seedCardOrder(loc.id)
    constructEvent.mockImplementation(() => {
      throw new Error('No signatures found matching the expected signature for payload')
    })

    const event = succeededEvent({ orderId: order.id, locationId: loc.id })
    const res = await deliver(event, 't=1,v1=forged')
    expect(res.status).toBe(400)

    // Order untouched, and — the ordering that matters — no claim row either. If the
    // idempotency insert ran before the signature check, anyone who could reach the
    // URL could burn an event id and make us drop the real delivery of it.
    const untouched = await readOrder(loc.id, order.id)
    expect(untouched.status).toBe('PENDING_PAYMENT')
    expect(untouched.paymentStatus).toBe('REQUIRES_PAYMENT')
    expect(await claimRows(event.id)).toHaveLength(0)
    expect(sendOrderCreated).not.toHaveBeenCalled()
  })

  it('refuses a request with no signature header at all', async () => {
    const res = await POST(new Request('https://serveside.test/api/stripe/webhook', {
      method: 'POST', body: '{}',
    }))
    expect(res.status).toBe(400)
    expect(constructEvent).not.toHaveBeenCalled()
  })

  it('records an event type it does not handle and answers 200', async () => {
    const loc = await seedLocationWithMenu({ prepTimeMinutes: PREP_TIME_MINUTES })
    const { order } = await seedCardOrder(loc.id)
    const event = succeededEvent({
      type: 'payment_intent.payment_failed', orderId: order.id, locationId: loc.id,
    })

    const res = await deliver(event)
    expect(res.status).toBe(200)
    // Recorded anyway: the claim is what stops a re-delivery being re-examined, and
    // the payload is the only record that Stripe told us anything at all.
    expect(await claimRows(event.id)).toHaveLength(1)

    const untouched = await readOrder(loc.id, order.id)
    expect(untouched.status).toBe('PENDING_PAYMENT')
    expect(sendOrderCreated).not.toHaveBeenCalled()
  })

  it('treats an order already past PENDING_PAYMENT as success, not a 500', async () => {
    // Stripe retries 5xx forever. An order that is already NEW — flipped by an earlier
    // delivery under a different event id, or by a human — is a legal state, so the
    // only thing a 500 would buy is a retry storm against a row nothing will change.
    const loc = await seedLocationWithMenu({ prepTimeMinutes: PREP_TIME_MINUTES })
    const { order } = await seedPaidOrder(loc.id)
    const eventsBefore = await countEvents(loc.id, order.id)

    const res = await deliver(succeededEvent({ orderId: order.id, locationId: loc.id }))
    expect(res.status).toBe(200)

    const untouched = await readOrder(loc.id, order.id)
    expect(untouched).toEqual(order)
    expect(await countEvents(loc.id, order.id)).toBe(eventsBefore)
    expect(sendOrderCreated).not.toHaveBeenCalled()
  })

  it('will not flip an order that is not in the location the event names', async () => {
    // The scope comes from `metadata.locationId`, and RLS is what enforces it: opened
    // against the wrong location, the order is simply not there. A cross-tenant flip
    // has to read as "no such order", never as a 500 and never as a write.
    const locA = await seedLocationWithMenu({ prepTimeMinutes: PREP_TIME_MINUTES })
    const locB = await seedLocationWithMenu({ prepTimeMinutes: PREP_TIME_MINUTES })
    const { order } = await seedCardOrder(locA.id)

    const res = await deliver(succeededEvent({ orderId: order.id, locationId: locB.id }))
    expect(res.status).toBe(200)

    const untouched = await readOrder(locA.id, order.id)
    expect(untouched.status).toBe('PENDING_PAYMENT')
    expect(sendOrderCreated).not.toHaveBeenCalled()
  })

  it('will not mark an order paid against an intent that is not the one it holds', async () => {
    // The order already named its PaymentIntent at checkout. An event about a
    // different one is either our bug or someone else's payment, and "mark it paid
    // and feed them" is the wrong guess either way — so it fails closed and loudly.
    const loc = await seedLocationWithMenu({ prepTimeMinutes: PREP_TIME_MINUTES })
    const { order } = await seedCardOrder(loc.id)

    const res = await deliver(succeededEvent({
      orderId: order.id, locationId: loc.id, paymentIntentId: 'pi_test_someone_elses',
    }))
    expect(res.status).toBe(200)

    const untouched = await readOrder(loc.id, order.id)
    expect(untouched.status).toBe('PENDING_PAYMENT')
    expect(untouched.paymentStatus).toBe('REQUIRES_PAYMENT')
    expect(sendOrderCreated).not.toHaveBeenCalled()
  })

  it('answers 200 for a succeeded intent whose metadata does not name an order', async () => {
    // Nothing here is retryable — a malformed event is malformed on every delivery —
    // so it is claimed, recorded and dropped rather than made into a retry storm.
    const event = succeededEvent({ orderId: 'not-a-uuid', locationId: 'also-not-a-uuid' })
    const res = await deliver(event)
    expect(res.status).toBe(200)
    expect(await claimRows(event.id)).toHaveLength(1)
    expect(sendOrderCreated).not.toHaveBeenCalled()
  })

  it('releases its claim when handling blows up, so the retry is not delivered onto a burnt id', async () => {
    // The cost of claiming *before* handling: a handler that dies has already taken
    // the id, and the retry would read as "already processed" and be dropped. So the
    // claim is released on the way out of an unexpected failure.
    const loc = await seedLocationWithMenu({ prepTimeMinutes: PREP_TIME_MINUTES })
    const { order } = await seedCardOrder(loc.id)
    sendOrderCreated.mockRejectedValueOnce(new Error('inngest is down'))

    const event = succeededEvent({
      orderId: order.id, locationId: loc.id, paymentIntentId: order.stripePaymentIntentId!,
    })
    const res = await deliver(event)
    expect(res.status).toBe(500)
    expect(await claimRows(event.id)).toHaveLength(0)

    // The flip itself committed — it is its own transaction, and the money really did
    // move. Stripe's retry therefore lands on an order that is already NEW, which is
    // the legal-state no-op above: 200, nothing written.
    const flipped = await readOrder(loc.id, order.id)
    expect(flipped.status).toBe('NEW')
    const eventsAfterFailure = await countEvents(loc.id, order.id)

    const retry = await deliver(event)
    expect(retry.status).toBe(200)
    expect(await countEvents(loc.id, order.id)).toBe(eventsAfterFailure)
  })
})
