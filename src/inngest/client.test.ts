import { describe, it, expect, beforeEach, vi } from 'vitest'
import { inngest, sendOrderCreated, ORDER_CREATED } from './client'

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
