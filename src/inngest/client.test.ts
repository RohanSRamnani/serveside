import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  inngest, sendOrderCreated, sendProvenanceRefused, sendStripeOutage,
  ORDER_CREATED, STRIPE_OUTAGE, INNGEST_SEND_TIMEOUT_MS,
} from './client'
import { SentryMiddleware } from './sentry-middleware'

/**
 * `sendOrderCreated` is three lines, and every one of them is an obligation the
 * Stripe webhook depends on:
 *
 * 1. **It is idempotent per order**, via the event `id`. Inngest deduplicates events
 *    that share one, which is what lets the webhook re-fire a fan-out it is not sure
 *    landed without printing a second ticket.
 * 2. **It throws on failure.** The webhook releases its idempotency claim and answers
 *    5xx when this rejects, and that is what makes Stripe retry a fan-out that never
 *    happened. Swallowing here is an order that is paid, flipped, and that no kitchen
 *    ever hears about.
 * 3. **It carries the location id.** The worker has no scope of its own; RLS hides the
 *    order row from anything that cannot name the location.
 *
 * `send` is spied rather than mocked at the module level, so the real client is the
 * thing under test and no event leaves the process.
 */
const send = vi.spyOn(inngest, 'send')

// Reset, never `mockRestore`: restoring puts the real `send` back for every test
// after the first, and the real one reaches for an event key and the network.
beforeEach(() => {
  send.mockReset()
  send.mockResolvedValue({ ids: ['01ABCDEF'] })
})

describe('sendOrderCreated', () => {
  it('sends order/created with both ids and an idempotency key made from the order', async () => {
    await sendOrderCreated('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222')

    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({
      name: ORDER_CREATED,
      data: {
        orderId: '11111111-1111-4111-8111-111111111111',
        locationId: '22222222-2222-4222-8222-222222222222',
      },
      // The `id` is the dedupe key, not a label: Inngest drops a second event that
      // carries one it has already seen, so the webhook's re-fire costs nothing.
      id: 'order-created-11111111-1111-4111-8111-111111111111',
    })
  })

  it('gives one order the same key twice and two orders different keys', async () => {
    const locationId = '22222222-2222-4222-8222-222222222222'
    await sendOrderCreated('11111111-1111-4111-8111-111111111111', locationId)
    await sendOrderCreated('11111111-1111-4111-8111-111111111111', locationId)
    await sendOrderCreated('33333333-3333-4333-8333-333333333333', locationId)

    const ids = send.mock.calls.map(([payload]) => (payload as { id: string }).id)
    // The first two are one order fanned out twice — the webhook's re-fire path — and
    // must collide. The third is a different order and must not: keying on anything
    // coarser (the location, the day) would silently drop real orders.
    expect(ids[0]).toBe(ids[1])
    expect(ids[2]).not.toBe(ids[0])
  })

  it('hands back the event ids Inngest accepted', async () => {
    // The only handle anyone gets on what actually happened: the API does not say
    // whether it kept the event or dropped it as a duplicate, so the webhook logs these
    // on the re-fire path and an operator searches the dashboard with them.
    send.mockResolvedValueOnce({ ids: ['01JEVENT1'] })
    await expect(
      sendOrderCreated('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'),
    ).resolves.toEqual(['01JEVENT1'])
  })

  it('throws when the send fails rather than reporting a fan-out that never happened', async () => {
    send.mockRejectedValueOnce(new Error('inngest is down'))
    await expect(
      sendOrderCreated('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'),
    ).rejects.toThrow('inngest is down')
  })
})

/**
 * **Every send is bounded**, and the bound lives here rather than at each caller.
 *
 * `POST /api/orders` sends after the order has committed and has `maxDuration = 60`: a
 * send that hangs gets the function killed, and the customer is told nothing was
 * ordered for an order that exists — so they order again. Bounded, a hang becomes the
 * ordinary thrown failure every caller already handles: the route logs it and answers
 * 200, the Stripe webhook releases its claim and answers 5xx so Stripe retries into the
 * re-fire path, and the canary records it as a failure.
 */
describe('the bounded send', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('is a few seconds — well inside the order route’s budget', () => {
    expect(INNGEST_SEND_TIMEOUT_MS).toBe(5_000)
  })

  it('turns a send that never answers into a thrown failure', async () => {
    vi.useFakeTimers()
    send.mockImplementation(() => new Promise(() => {}))

    const hung = sendOrderCreated('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222')
    const settled = expect(hung).rejects.toThrow(/order\/created.*did not settle within 5000ms/)
    await vi.advanceTimersByTimeAsync(INNGEST_SEND_TIMEOUT_MS)
    await settled
  })

  it('bounds the provenance alarm and the Stripe-outage alarm the same way', async () => {
    vi.useFakeTimers()
    send.mockImplementation(() => new Promise(() => {}))

    const provenance = sendProvenanceRefused({
      orderId: '11111111-1111-4111-8111-111111111111',
      locationId: '22222222-2222-4222-8222-222222222222',
      reason: 'account_mismatch',
    }, 'evt_1')
    const outage = sendStripeOutage('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222')
    const both = Promise.all([
      expect(provenance).rejects.toThrow(/did not settle/),
      expect(outage).rejects.toThrow(/did not settle/),
    ])
    await vi.advanceTimersByTimeAsync(INNGEST_SEND_TIMEOUT_MS)
    await both
  })
})

describe('sendStripeOutage', () => {
  it('sends ids only, keyed on the order so one conversion is one event', async () => {
    await sendStripeOutage('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222')

    expect(send).toHaveBeenCalledWith({
      name: STRIPE_OUTAGE,
      data: {
        orderId: '11111111-1111-4111-8111-111111111111',
        locationId: '22222222-2222-4222-8222-222222222222',
      },
      id: 'stripe-outage-11111111-1111-4111-8111-111111111111',
    })
  })
})

describe('the client', () => {
  it('reports every failed run to Sentry through its middleware', () => {
    // Inngest catches a function's errors itself and reports them to the orchestrator,
    // so Next's `onRequestError` never sees them. The middleware is how they reach us.
    expect(inngest.middleware).toContain(SentryMiddleware)
  })
})
