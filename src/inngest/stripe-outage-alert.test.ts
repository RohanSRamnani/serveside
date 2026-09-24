import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { InngestTestEngine } from '@inngest/test'
import type { GetStepTools } from 'inngest'
import { db } from '@/db/client'
import { paymentFailovers } from '@/db/schema'
import { inngest as inngestClient, STRIPE_OUTAGE } from '@/inngest/client'
import { seedLocationWithMenu, seedPickupOrder, quietFailoverAlerts } from '@/test/seed'

/**
 * The alarm for a Stripe that has stopped answering.
 *
 * The order route already survives it — a card order Stripe cannot take is converted to
 * pay-at-pickup rather than refused — and that is exactly why it needs an alarm: the
 * failover is silent by design, so an outage that lasts all evening is a restaurant
 * collecting every card order's money at the counter while nobody on our side knows.
 *
 * **One text an hour, for the whole platform.** Stripe is one dependency for every
 * restaurant, so one outage is one page, not one per restaurant per hour. Each
 * conversion writes a `payment_failovers` row in its own transaction; this reads
 * `max(alerted_at)` across all of them, texts if nothing went out in the last hour, and
 * stamps the row it texted about *after* the send — the heartbeat's order.
 */
const { sendSms } = vi.hoisted(() => ({ sendSms: vi.fn() }))
vi.mock('@/lib/sms', () => ({ sendSms }))

const {
  stripeOutageAlert, alertStripeOutage, STRIPE_OUTAGE_ALERT_COOLDOWN_MS,
} = await import('./stripe-outage-alert')

const OPS_PHONE = '+15550005555'
const MINUTE = 60_000

/** A step that simply runs the work — see `order-created.test.ts` for why. */
const step = {
  run: (_id: string, fn: () => Promise<unknown>) => fn(),
} as unknown as GetStepTools<typeof inngestClient>

/** An order the route converted: the row the conversion writes, as it writes it. */
async function converted(): Promise<{ orderId: string; locationId: string }> {
  const loc = await seedLocationWithMenu()
  const { order } = await seedPickupOrder(loc.id)
  await db().insert(paymentFailovers).values({ orderId: order.id, locationId: loc.id })
  return { orderId: order.id, locationId: loc.id }
}

async function readFailover(orderId: string) {
  const [row] = await db().select().from(paymentFailovers).where(eq(paymentFailovers.orderId, orderId))
  return row
}

beforeEach(async () => {
  sendSms.mockReset()
  sendSms.mockResolvedValue(undefined)
  vi.stubEnv('OPS_ALERT_E164', OPS_PHONE)
  await quietFailoverAlerts()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('the Stripe-outage alarm', () => {
  it('listens for the event the route sends, one run at a time', () => {
    expect(stripeOutageAlert.opts.triggers).toEqual([{ event: STRIPE_OUTAGE }])
    // An outage converts every card order at once. Serialised, the first run texts and
    // stamps before the second reads the cooldown — so a burst is one text, not ten.
    expect(stripeOutageAlert.opts.concurrency).toEqual({ limit: 1 })
    expect(STRIPE_OUTAGE_ALERT_COOLDOWN_MS).toBe(60 * MINUTE)
  })

  it('texts us on the first conversion, and stamps that conversion', async () => {
    const first = await converted()

    const result = await alertStripeOutage(first, step)

    expect(result).toEqual({ orderId: first.orderId, alerted: true })
    expect(sendSms).toHaveBeenCalledTimes(1)
    expect(sendSms.mock.calls[0][0]).toBe(OPS_PHONE)
    expect(sendSms.mock.calls[0][1]).toMatch(/^Serveside: Stripe is failing\. \d+ card orders? switched to pay at pickup in the last hour\./)
    expect((await readFailover(first.orderId)).alertedAt).toBeInstanceOf(Date)
  })

  it('stays quiet for every other conversion inside the hour', async () => {
    const first = await converted()
    const second = await converted()

    await alertStripeOutage(first, step)
    const quiet = await alertStripeOutage(second, step)

    expect(quiet).toEqual({ orderId: second.orderId, alerted: false })
    expect(sendSms).toHaveBeenCalledTimes(1)
    // Not stamped: nothing went out about it, and restarting the clock on a silent run
    // would push the next text out for ever.
    expect((await readFailover(second.orderId)).alertedAt).toBeNull()
  })

  it('texts again once the hour is up, if Stripe is still failing', async () => {
    const first = await converted()
    await alertStripeOutage(first, step)
    await db().update(paymentFailovers)
      .set({ alertedAt: new Date(Date.now() - 61 * MINUTE) })
      .where(eq(paymentFailovers.orderId, first.orderId))

    const later = await converted()
    expect(await alertStripeOutage(later, step)).toEqual({ orderId: later.orderId, alerted: true })
    expect(sendSms).toHaveBeenCalledTimes(2)
  })

  it('does not start the hour when the text could not be sent', async () => {
    const first = await converted()
    sendSms.mockRejectedValueOnce(new Error('twilio is down'))

    await expect(alertStripeOutage(first, step)).rejects.toThrow('twilio is down')
    expect((await readFailover(first.orderId)).alertedAt).toBeNull()

    // The step's retry — the same event — goes out once Twilio is back.
    expect(await alertStripeOutage(first, step)).toEqual({ orderId: first.orderId, alerted: true })
  })

  it('refuses an event that does not name an order, rather than texting about nothing', async () => {
    for (const data of [undefined, { orderId: 'nope', locationId: 'nope' }, { orderId: '11111111-1111-4111-8111-111111111111' }]) {
      await expect(alertStripeOutage(data, step), JSON.stringify(data)).rejects.toThrow(/payments\/stripe-outage/)
    }
    expect(sendSms).not.toHaveBeenCalled()
  })

  it('runs through the harness as the registered function', async () => {
    const first = await converted()

    const out = await new InngestTestEngine({ function: stripeOutageAlert }).execute({
      events: [{ name: STRIPE_OUTAGE, data: first }],
      disableImmediateExecution: true,
    })

    const err = out.error as { message?: string } | undefined
    expect(err?.message ?? '').toBe('')
    expect(out.result).toEqual({ orderId: first.orderId, alerted: true })
    expect(sendSms).toHaveBeenCalledWith(OPS_PHONE, expect.stringContaining('Stripe is failing'))
  })
})
