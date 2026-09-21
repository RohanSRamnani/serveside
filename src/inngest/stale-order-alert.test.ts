import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { InngestTestEngine } from '@inngest/test'
import type { GetStepTools } from 'inngest'
import { orders } from '@/db/schema'
import { inngest as inngestClient } from '@/inngest/client'
import { withLocation } from '@/repo/scoped'
import { seedLocationWithMenu, seedBusinessHours, seedPaidOrder, type SeededMenu } from '@/test/seed'

/**
 * The Friday-night alarm: an order lands, the tablet is face-down on a shelf, and
 * nobody taps Accept. Fifteen minutes later a customer arrives for food that was
 * never started.
 *
 * Three rules, and every test here is one of them:
 *
 * 1. **The restaurant is paged first, we are paged second.** The owner can fix this
 *    in one tap; we cannot cook. Ops only hears about it once the restaurant has been
 *    told and has still done nothing for four more minutes.
 * 2. **Accepting cancels the alarm by itself.** There is no cancellation event and no
 *    bookkeeping: each leg re-reads the order, and an order that has moved off NEW is
 *    an order somebody is dealing with.
 * 3. **Nobody is woken for a closed restaurant.** A pay-at-pickup order placed at
 *    23:58 must not ring an owner's phone at 00:04, and it must not ring ours either.
 *
 * `sendSms` is mocked because a test that reaches Twilio spends money and fails in
 * CI — `.env.test` deliberately has no Twilio credentials, so a leak here is a loud
 * `env()` throw rather than a text message. Everything else is real: the database,
 * the RLS scope and the hours check.
 */
const { sendSms } = vi.hoisted(() => ({ sendSms: vi.fn() }))
vi.mock('@/lib/sms', () => ({ sendSms }))

const {
  staleOrderAlert, escalateStaleOrder, ACCEPT_GRACE, OPS_ESCALATION,
} = await import('./stale-order-alert')

/** Rohan's phone, stubbed rather than taken from `.env.test` so the assertion is a literal. */
const OPS_PHONE = '+15550009999'

let phones = 0

/**
 * A restaurant with a phone number of its own — the same precaution
 * `order-created.test.ts` takes, and for the same reason: a step the harness
 * re-issued can land after the test that started it, so a test asserting "nobody was
 * texted" needs to tell its own silence from the previous test's echo.
 *
 * `open` is what the hours grid says. A restaurant with no hours posted at all is
 * closed, which is the state the third rule above is about.
 */
async function restaurant({ open = true } = {}): Promise<SeededMenu> {
  const loc = await seedLocationWithMenu({
    name: 'Kashi',
    phoneE164: `+1555${String(2_000_000 + phones++)}`,
  })
  if (open) await seedBusinessHours(loc.id)
  return loc
}

/** Every text sent to one number, ignoring any still in flight for another. */
function textsTo(phone: string): string[] {
  return sendSms.mock.calls.filter(([to]) => to === phone).map(([, body]) => body as string)
}

function setStatus(locationId: string, orderId: string, status: 'ACCEPTED' | 'CANCELED'): Promise<unknown> {
  return withLocation(locationId, (tx) => tx.update(orders).set({ status }).where(eq(orders.id, orderId)))
}

/** One run of the escalation, with both waits already served. */
function escalate(orderId: string, locationId: string) {
  return new InngestTestEngine({
    function: staleOrderAlert,
    // The timers, faked. A `step.sleep` has no handler of its own — mocking it by id
    // is how the harness is told the wait is over, which is the only way to test a
    // ten-minute escalation in a ten-millisecond test.
    steps: [
      { id: 'wait-for-accept', handler: () => null },
      { id: 'wait-for-ops', handler: () => null },
    ],
  }).execute({
    events: [{ name: 'order/created', data: { orderId, locationId } }],
    disableImmediateExecution: true,
  })
}

/** The run's failure, flattened — the engine hands back a serialized error, not an `Error`. */
function failure(out: { error?: unknown }): string {
  const err = out.error as { name?: string; message?: string } | undefined
  return err ? `${err.name ?? 'Error'}: ${err.message ?? ''}` : ''
}

beforeEach(() => {
  sendSms.mockReset()
  sendSms.mockResolvedValue(undefined)
  vi.stubEnv('OPS_ALERT_E164', OPS_PHONE)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('the stale-order alarm', () => {
  it('texts the restaurant after six minutes, then us four minutes later', async () => {
    const loc = await restaurant()
    const { order } = await seedPaidOrder(loc.id)

    const out = await escalate(order.id, loc.id)
    expect(failure(out)).toBe('')

    // The owner's copy names the one tap that fixes it. Not "there is a problem with
    // order K7M2" — a sentence someone reads on a phone between two other things has
    // to say what to do.
    expect(textsTo(loc.phoneE164)).toContain(
      `Order ${order.shortCode} has been waiting 6 min — tap Accept on the tablet`,
    )
    // Ours names the restaurant, because we have more than one of them, and says the
    // owner has already been told so the first call we make is not one they have had.
    expect(textsTo(OPS_PHONE)).toContain(
      `Serveside: Kashi has not accepted order ${order.shortCode} in 10 min. Owner already texted.`,
    )
  })

  it('says nothing at all once the order has been accepted', async () => {
    // The cancellation path, and there is deliberately no cancellation event: the leg
    // re-reads the order and finds it is somebody's problem now.
    const loc = await restaurant()
    const { order } = await seedPaidOrder(loc.id)
    await setStatus(loc.id, order.id, 'ACCEPTED')

    const out = await escalate(order.id, loc.id)
    expect(failure(out)).toBe('')
    expect(out.result).toMatchObject({ outcome: 'no-longer-new' })

    expect(textsTo(loc.phoneE164)).toHaveLength(0)
    expect(textsTo(OPS_PHONE)).toHaveLength(0)
  })

  it('stops after the first text when the order is accepted during the four-minute grace', async () => {
    // The escalation is two decisions, not one with a delay: the owner gets their
    // text, taps Accept two minutes later, and we are never woken.
    const loc = await restaurant()
    const { order } = await seedPaidOrder(loc.id)

    const result = await escalateStaleOrder(
      { orderId: order.id, locationId: loc.id },
      stepThatWaits(() => setStatus(loc.id, order.id, 'ACCEPTED')),
    )

    expect(result.outcome).toBe('no-longer-new')
    expect(textsTo(loc.phoneE164)).toHaveLength(1)
    expect(textsTo(OPS_PHONE)).toHaveLength(0)
  })

  it('wakes nobody for a closed restaurant', async () => {
    // Hours-aware paging, which is the difference between an alarm people keep and an
    // alarm people mute. An order placed just before close must not ring an owner's
    // phone after it — and must not ring ours either.
    const loc = await restaurant({ open: false })
    const { order } = await seedPaidOrder(loc.id)

    const result = await escalateStaleOrder({ orderId: order.id, locationId: loc.id }, plainStep())

    expect(result.outcome).toBe('closed')
    expect(textsTo(loc.phoneE164)).toHaveLength(0)
    expect(textsTo(OPS_PHONE)).toHaveLength(0)
  })

  it('waits six minutes before doing anything, and four more before escalating', async () => {
    // Pinned because the numbers *are* the product decision. Six minutes is long
    // enough that a kitchen mid-rush is not nagged and short enough that the customer
    // is still ten minutes from the door; four more is one more look at the tablet.
    const loc = await restaurant()
    const { order } = await seedPaidOrder(loc.id)
    const waited: string[] = []

    await escalateStaleOrder({ orderId: order.id, locationId: loc.id }, plainStep(waited))

    expect(waited).toEqual([ACCEPT_GRACE, OPS_ESCALATION])
    expect(ACCEPT_GRACE).toBe('6m')
    expect(OPS_ESCALATION).toBe('4m')
  })

  it('refuses an event that does not name an order, before it touches a query', async () => {
    // The payload arrives over HTTP from the orchestrator, so it is input. A malformed
    // uuid reaching Postgres is a 22P02 that poisons the whole transaction — the same
    // ruling the fan-out and the Stripe webhook make about their own ids.
    const loc = await restaurant()

    const out = await escalate('not-a-uuid', loc.id)

    expect(failure(out)).toMatch(/order\/created/)
    expect(textsTo(loc.phoneE164)).toHaveLength(0)
    expect(textsTo(OPS_PHONE)).toHaveLength(0)
  })

  it('says nothing about an order that is not in the location the event names', async () => {
    // Tenancy by RLS rather than by a WHERE clause: opened against the wrong location
    // the order is simply not there. Texting on the strength of an unreadable order
    // would be telling one restaurant about another's dinner service.
    const locA = await restaurant()
    const locB = await restaurant()
    const { order } = await seedPaidOrder(locA.id)

    const result = await escalateStaleOrder({ orderId: order.id, locationId: locB.id }, plainStep())

    expect(result.outcome).toBe('gone')
    expect(textsTo(locA.phoneE164)).toHaveLength(0)
    expect(textsTo(locB.phoneE164)).toHaveLength(0)
    expect(textsTo(OPS_PHONE)).toHaveLength(0)
  })
})

/**
 * A `step` that runs the work and serves every wait instantly, recording what it was
 * asked to wait for.
 *
 * The house pattern, for the reason CLAUDE.md gives: `@inngest/test` settles a run at
 * the first errored step and never delivers a mocked failure to the function body, so
 * anything past a failure — and the function's own return value — is only reachable
 * with a `step` of the test's own making. Here it also buys precision: the harness
 * re-executes steps of its own accord, so `waited` is the only honest way to see what
 * the escalation actually asked for.
 */
function plainStep(waited: string[] = []): GetStepTools<typeof inngestClient> {
  return {
    run: (_id: string, fn: () => Promise<unknown>) => fn(),
    sleep: (_id: string, time: string) => { waited.push(time); return Promise.resolve() },
  } as unknown as GetStepTools<typeof inngestClient>
}

/** The same, except that something happens to the order while the second wait runs. */
function stepThatWaits(during: () => Promise<unknown>): GetStepTools<typeof inngestClient> {
  let waits = 0
  return {
    run: (_id: string, fn: () => Promise<unknown>) => fn(),
    sleep: async () => { if (++waits === 2) await during() },
  } as unknown as GetStepTools<typeof inngestClient>
}
