import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq, notInArray } from 'drizzle-orm'
import { InngestTestEngine } from '@inngest/test'
import type { GetStepTools } from 'inngest'
import { db } from '@/db/client'
import { canaryRuns, orderEvents, orders, organizations, printers, printJobs } from '@/db/schema'
import { inngest as inngestClient } from '@/inngest/client'
import { withLocation } from '@/repo/scoped'
import {
  seedLocationWithMenu, seedBusinessHours, seedPaidOrder, seedPrinter, seedLocation,
  quietCanary, quietProbeWindow, inngestRunId,
} from '@/test/seed'
import { buildMenuSnapshot } from '@/domain/snapshot'
import { seedCanary } from '../../scripts/seed-canary'

/**
 * The synthetic canary: a one-cent order every few minutes, through the same code a
 * customer's order goes through, to prove that an order still becomes a ticket.
 *
 * The properties under test are the ones that make a canary trustworthy rather than a
 * second source of alarms:
 *
 * - **It exercises the real path.** `createOrder`, then the announce the route makes
 *   (`sendOrderCreated`), then the real fan-out — driven here by the `sendOrderCreated`
 *   mock, standing in for the orchestrator delivering the event. Nothing inserts a print
 *   job on the canary's behalf.
 * - **It cleans up after itself on every run**, including the runs whose check failed or
 *   threw, so the table never fills with NEW orders and the canary never trips the
 *   unpaid-order cap it would otherwise hit on its eleventh failure of the day.
 * - **It never texts anyone but us**, and us only on the second failure in a row, once an
 *   hour.
 *
 * `sendSms` is mocked as everywhere. The database is real.
 */
const { sendSms, sendOrderCreated } = vi.hoisted(() => ({
  sendSms: vi.fn(),
  sendOrderCreated: vi.fn(),
}))
vi.mock('@/lib/sms', () => ({ sendSms }))
vi.mock('@/inngest/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/inngest/client')>(),
  sendOrderCreated,
}))

const {
  canary, runCanary, placeCanaryOrder, cleanUpCanary,
  CANARY_SCHEDULE, CANARY_TICKET_WAIT, CANARY_FAILURES_BEFORE_ALERT, CANARY_ALERT_COOLDOWN_MS,
} = await import('./canary')
const { findCanaryLocation, CANARY_LOCATION_PHONE, CANARY_ITEM_PRICE_CENTS } = await import('@/domain/canary')
const { fanOut } = await import('./order-created')
const { escalateStaleOrder } = await import('./stale-order-alert')
const { sweepPrinters } = await import('./printer-heartbeat')

const OPS_PHONE = '+15550006666'
const MINUTE = 60_000

/**
 * A canary run against the Neon `test` branch — place, check, cancel, record — is a
 * second or more of round trips, so a test of several runs is past vitest's five-second
 * default (eleven runs is ~15s). And a test that times out keeps running in the
 * background, its late calls landing in the next test's mocks — so the bound is set once,
 * generously, for the whole block rather than tuned test by test.
 */
const RUNS_MS = 60_000

let slugs = 0

/** A canary location of this test's own, seeded by the production seeder under a fresh org. */
async function canaryLocation(): Promise<{ id: string; itemId: string }> {
  const summary = await seedCanary({ orgSlug: `test-canary-${Date.now()}-${slugs++}` })
  return { id: summary.locationId, itemId: summary.itemId }
}

/** The location resolver, answered with this test's own location. */
function at(locationId: string) {
  return async () => ({ ok: true as const, locationId })
}

/**
 * A `step` that runs the work in-process, except for the one step named as broken —
 * which rejects the way a step does once Inngest has exhausted its retries. Sleeps are
 * served at once. `seen` records every step id in the order the canary asked for it.
 */
function fakeStep(broken?: string, seen: string[] = []): GetStepTools<typeof inngestClient> {
  return {
    run: (id: string, fn: () => Promise<unknown>) => {
      seen.push(id)
      return id === broken ? Promise.reject(new Error(`${id} is down`)) : fn()
    },
    sleep: (id: string) => {
      seen.push(id)
      return Promise.resolve()
    },
  } as unknown as GetStepTools<typeof inngestClient>
}

/** A `step` that simply runs the work — for driving the fan-out and the heartbeat. */
function plainStep(): GetStepTools<typeof inngestClient> {
  return { run: (_id: string, fn: () => Promise<unknown>) => fn() } as unknown as GetStepTools<typeof inngestClient>
}

/** The heartbeat's scan, answered with one location — see `printer-heartbeat.test.ts`. */
function heartbeatStep(locationIds: string[]): GetStepTools<typeof inngestClient> {
  return {
    run: (id: string, fn: () => Promise<unknown>) => (id === 'list-locations' ? Promise.resolve(locationIds) : fn()),
  } as unknown as GetStepTools<typeof inngestClient>
}

/** What the orchestrator does with `order/created`: run the real fan-out for it. */
async function deliverToFanOut(orderId: string, locationId: string): Promise<string[]> {
  await fanOut({ orderId, locationId }, plainStep())
  return ['01JCANARYEVENT']
}

async function readRun(runId: string) {
  const [row] = await db().select().from(canaryRuns).where(eq(canaryRuns.inngestRunId, runId))
  return row
}

function ordersAt(locationId: string) {
  return withLocation(locationId, (tx) => tx.select().from(orders))
}

function openOrdersAt(locationId: string) {
  return withLocation(locationId, (tx) => tx.select().from(orders)
    .where(notInArray(orders.status, ['COMPLETED', 'REJECTED', 'CANCELED'])))
}

function jobsFor(locationId: string, orderId: string) {
  return withLocation(locationId, (tx) => tx.select().from(printJobs).where(eq(printJobs.orderId, orderId)))
}

function queuedJobsAt(locationId: string) {
  return withLocation(locationId, (tx) => tx.select().from(printJobs).where(eq(printJobs.status, 'queued')))
}

async function readOrder(locationId: string, orderId: string) {
  const [row] = await withLocation(locationId, (tx) => tx.select().from(orders).where(eq(orders.id, orderId)))
  return row
}

function textsTo(phone: string): string[] {
  return sendSms.mock.calls.filter(([to]) => to === phone).map(([, body]) => body as string)
}

/** One run, as the cron would start it, against this test's own location. */
function run(locationId: string, broken?: string) {
  return runCanary(fakeStep(broken), { runId: inngestRunId(), findLocation: at(locationId) })
}

beforeEach(() => {
  sendSms.mockReset()
  sendSms.mockResolvedValue(undefined)
  sendOrderCreated.mockReset()
  sendOrderCreated.mockImplementation(deliverToFanOut)
  vi.stubEnv('OPS_ALERT_E164', OPS_PHONE)
  vi.stubEnv('FEED_URL', 'https://serveside.test/feed')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('the synthetic canary', { timeout: RUNS_MS }, () => {
  it('runs on one named schedule, one run at a time, and gives up on a run that hangs', () => {
    // The schedule is ONE constant so the founder can move it (it is most of the
    // canary's Inngest bill) without hunting for a second copy.
    expect(CANARY_SCHEDULE).toBe('*/5 * * * *')
    expect(canary.opts.triggers).toEqual([{ cron: CANARY_SCHEDULE }])
    // Its clean-up sweeps every open order at the synthetic location, which is only safe
    // if no other canary run is mid-flight — so a tick that finds one running is skipped.
    expect(canary.opts.singleton).toEqual({ mode: 'skip' })
    // …and a run that is somehow stuck cannot hold that lock for ever.
    expect(canary.opts.timeouts).toEqual({ finish: '15m' })
    expect(CANARY_TICKET_WAIT).toBe('1m')
    expect(CANARY_FAILURES_BEFORE_ALERT).toBe(2)
    expect(CANARY_ALERT_COOLDOWN_MS).toBe(60 * MINUTE)
  })

  it('places a real one-cent order, sees its ticket, and leaves nothing behind', async () => {
    const loc = await canaryLocation()
    await quietCanary()
    let ticketId: string | undefined
    sendOrderCreated.mockImplementation(async (orderId: string, locationId: string) => {
      await deliverToFanOut(orderId, locationId)
      // The ticket the real fan-out queued — what the canary has to find.
      ticketId = (await jobsFor(locationId, orderId))[0]?.id
      return ['01JCANARYEVENT']
    })

    const runId = inngestRunId()
    const seen: string[] = []
    const result = await runCanary(fakeStep(undefined, seen), { runId, findLocation: at(loc.id) })

    expect(result).toMatchObject({ runId, outcome: 'confirmed', failure: null, alerted: false })
    expect(ticketId).toEqual(expect.any(String))
    // Five steps, and the order is the design: place, wait, look, clean up, record.
    expect(seen).toEqual(['place-order', 'wait-for-ticket', 'check-ticket', 'clean-up', 'record-outcome'])

    // Announced exactly the way `POST /api/orders` announces a pay-at-pickup order —
    // the same function, the same ids — or the canary proves a path nobody uses.
    expect(sendOrderCreated).toHaveBeenCalledWith(result.orderId, loc.id)

    const run = await readRun(runId)
    expect(run).toMatchObject({
      outcome: 'confirmed',
      locationId: loc.id,
      orderId: result.orderId,
      // The ticket it saw, recorded before it was removed.
      printJobId: ticketId,
      failureReason: null,
      alertedAt: null,
    })
    expect(run.finishedAt).toBeInstanceOf(Date)

    // Real money arithmetic on a real row: one cent, NYC tax rounds half-up to nothing.
    const order = await readOrder(loc.id, result.orderId!)
    expect(order).toMatchObject({
      status: 'CANCELED',
      paymentStatus: 'PAY_ON_PICKUP',
      channel: 'web',
      subtotalCents: CANARY_ITEM_PRICE_CENTS,
      taxCents: 0,
      tipCents: 0,
      totalCents: 1,
    })
    expect(order.canceledAt).toBeInstanceOf(Date)
    // A fresh fictional customer: area code 555, which the NANP never assigns.
    expect(order.contactPhone).toMatch(/^\+1555\d{7}$/)

    // Cancelled through the machine, so the audit trail says who ended it.
    const events = await withLocation(loc.id, (tx) =>
      tx.select().from(orderEvents).where(eq(orderEvents.orderId, result.orderId!)))
    expect(events.find((e) => e.type === 'status_changed')?.payload).toMatchObject({ from: 'NEW', to: 'CANCELED' })

    // The ticket is out of the queue: a synthetic location has no printer, so a queued
    // job there would sit in `print_jobs_queued_idx` for ever.
    expect(await jobsFor(loc.id, result.orderId!)).toEqual([])
    expect(await queuedJobsAt(loc.id)).toEqual([])
    expect(await openOrdersAt(loc.id)).toEqual([])

    expect(sendSms).not.toHaveBeenCalled()
  })

  it('records a missing ticket as a failure, and still cancels its order', async () => {
    const loc = await canaryLocation()
    await quietCanary()
    // The event is accepted and nothing ever runs for it — a fan-out that is not
    // registered, an orchestrator that is down. Exactly what the canary is for.
    sendOrderCreated.mockResolvedValue(['01JLOSTEVENT'])

    const runId = inngestRunId()
    const result = await runCanary(fakeStep(), { runId, findLocation: at(loc.id) })

    expect(result.outcome).toBe('failed')
    expect(result.failure).toMatch(/no print job/)
    expect(result.alerted).toBe(false)
    expect((await readOrder(loc.id, result.orderId!)).status).toBe('CANCELED')
    expect(await readRun(runId)).toMatchObject({ outcome: 'failed', failureReason: result.failure, printJobId: null })
  })

  it('cancels its order even when the ticket check itself blows up', async () => {
    // A database blip that outlives the check step's retries reaches the function body
    // as a thrown step. The clean-up is a step of its own, after it, so it still runs.
    const loc = await canaryLocation()
    await quietCanary()

    const result = await run(loc.id, 'check-ticket')

    expect(result.outcome).toBe('failed')
    expect(result.failure).toMatch(/ticket check failed: check-ticket is down/)
    expect((await readOrder(loc.id, result.orderId!)).status).toBe('CANCELED')
    expect(await queuedJobsAt(loc.id)).toEqual([])
  })

  it('texts us on the second failure in a row, once, and not again inside the hour', async () => {
    const loc = await canaryLocation()
    await quietCanary()
    sendOrderCreated.mockResolvedValue(['01JLOSTEVENT'])

    // One failure is a blip, not a page: a Neon cold start or a slow orchestrator.
    const first = await run(loc.id)
    expect(first).toMatchObject({ outcome: 'failed', alerted: false })
    expect(sendSms).not.toHaveBeenCalled()

    // Two in a row is the threshold.
    const second = await run(loc.id)
    expect(second).toMatchObject({ outcome: 'failed', alerted: true })
    expect(textsTo(OPS_PHONE)).toHaveLength(1)
    expect(textsTo(OPS_PHONE)[0]).toMatch(/^Serveside canary: 2 synthetic orders in a row failed/)
    expect(textsTo(OPS_PHONE)[0]).toContain('no print job')
    // Stamped on the run that sent it, after the send.
    expect((await readRun(second.runId)).alertedAt).toBeInstanceOf(Date)

    // Every five minutes after that is still failing — and still silent, for an hour.
    const third = await run(loc.id)
    expect(third).toMatchObject({ outcome: 'failed', alerted: false })
    expect(textsTo(OPS_PHONE)).toHaveLength(1)
    expect((await readRun(third.runId)).alertedAt).toBeNull()

    // Nobody but us: the canary location's own number is never the one that rings.
    expect(textsTo(CANARY_LOCATION_PHONE)).toEqual([])
  })

  it('texts again once the hour is up, if it is still failing', async () => {
    const loc = await canaryLocation()
    await quietCanary()
    sendOrderCreated.mockResolvedValue(['01JLOSTEVENT'])

    await run(loc.id)
    const paged = await run(loc.id)
    expect(paged.alerted).toBe(true)
    await db().update(canaryRuns)
      .set({ alertedAt: new Date(Date.now() - 61 * MINUTE) })
      .where(eq(canaryRuns.inngestRunId, paged.runId))

    const later = await run(loc.id)
    expect(later.alerted).toBe(true)
    expect(textsTo(OPS_PHONE)).toHaveLength(2)
  })

  it('does not count a failure that follows a success as two in a row', async () => {
    const loc = await canaryLocation()
    await quietCanary()

    sendOrderCreated.mockResolvedValue(['01JLOSTEVENT'])
    expect((await run(loc.id)).outcome).toBe('failed')

    sendOrderCreated.mockImplementation(deliverToFanOut)
    expect((await run(loc.id)).outcome).toBe('confirmed')

    sendOrderCreated.mockResolvedValue(['01JLOSTEVENT'])
    const after = await run(loc.id)
    expect(after).toMatchObject({ outcome: 'failed', alerted: false })
    expect(sendSms).not.toHaveBeenCalled()
  })

  it('does not start the hour when the text could not be sent', async () => {
    // Send first, stamp after — the heartbeat's rule. A Twilio outage must not buy an
    // hour of silence about a broken order path.
    const loc = await canaryLocation()
    await quietCanary()
    sendOrderCreated.mockResolvedValue(['01JLOSTEVENT'])
    await run(loc.id)

    sendSms.mockRejectedValue(new Error('twilio is down'))
    const runId = inngestRunId()
    await expect(runCanary(fakeStep(), { runId, findLocation: at(loc.id) })).rejects.toThrow(/twilio is down/)
    // The verdict was recorded before the text was attempted; the stamp was not.
    expect(await readRun(runId)).toMatchObject({ outcome: 'failed', alertedAt: null })

    sendSms.mockReset()
    sendSms.mockResolvedValue(undefined)
    expect((await run(loc.id)).alerted).toBe(true)
  })

  it('leaves no open order behind after eleven failing runs, and the cap never refuses one', async () => {
    // Eleven, because the unpaid-order cap is ten open pay-at-pickup orders per phone
    // per location per day: a canary that did not clean up, on one phone, would fail
    // its eleventh run with `unpaid_order_cap` — and report an outage that is its own.
    const loc = await canaryLocation()
    await quietCanary()
    sendOrderCreated.mockResolvedValue(['01JLOSTEVENT'])

    for (let i = 0; i < 11; i++) {
      // Every other run, the check itself throws rather than finding nothing.
      const result = await run(loc.id, i % 2 === 1 ? 'check-ticket' : undefined)
      expect(result.outcome, `run ${i + 1}`).toBe('failed')
      expect(result.orderId, `run ${i + 1} placed its order`).toEqual(expect.any(String))
      expect(result.failure, `run ${i + 1}`).not.toMatch(/unpaid_order_cap/)
    }

    expect(await openOrdersAt(loc.id)).toEqual([])
    expect(await ordersAt(loc.id)).toHaveLength(11)
    expect(await queuedJobsAt(loc.id)).toEqual([])
  })

  it('still places its order when earlier runs could not clean up — every run is a new customer', async () => {
    // The second defence, proved on its own: with the clean-up broken, eleven open
    // pay-at-pickup orders pile up at one location on one day — and the eleventh is
    // still accepted, because each run is a different fictional phone number.
    const loc = await canaryLocation()
    await quietCanary()
    sendOrderCreated.mockResolvedValue(['01JLOSTEVENT'])

    for (let i = 0; i < 11; i++) {
      const result = await run(loc.id, 'clean-up')
      expect(result.orderId, `run ${i + 1} placed its order`).toEqual(expect.any(String))
      expect(result.failure, `run ${i + 1}`).not.toMatch(/unpaid_order_cap/)
    }
    const open = await openOrdersAt(loc.id)
    expect(open).toHaveLength(11)
    expect(new Set(open.map((order) => order.contactPhone)).size).toBe(11)

    // And the first healthy run sweeps every leftover along with its own order.
    await run(loc.id)
    expect(await openOrdersAt(loc.id)).toEqual([])
  })

  it('places one order however many times its placing step runs', async () => {
    // Inngest steps are at-least-once: a step whose result was lost on the way back is
    // run again. The run row is keyed on the Inngest run id, so the second attempt finds
    // the order the first one placed and announces that — idempotent per order — rather
    // than placing another.
    const loc = await canaryLocation()
    const runId = inngestRunId()

    const first = await placeCanaryOrder(runId, at(loc.id))
    const second = await placeCanaryOrder(runId, at(loc.id))

    expect(first.orderId).toEqual(expect.any(String))
    expect(second).toEqual(first)
    expect(await ordersAt(loc.id)).toHaveLength(1)
    expect(sendOrderCreated).toHaveBeenCalledTimes(2)
    expect(await db().select().from(canaryRuns).where(eq(canaryRuns.inngestRunId, runId))).toHaveLength(1)
  })

  it('records a failure somebody can act on when there is no canary location', async () => {
    const runId = inngestRunId()
    const result = await runCanary(fakeStep(), {
      runId,
      findLocation: () => findCanaryLocation(`no-such-canary-${Date.now()}`),
    })

    expect(result).toMatchObject({ outcome: 'failed', orderId: null })
    expect(result.failure).toMatch(/npm run seed:canary/)
    expect(await readRun(runId)).toMatchObject({ outcome: 'failed', locationId: null, orderId: null })
  })

  it('will not order from, or clean up, a real restaurant', async () => {
    // The clean-up cancels every open order at its location. Pointed at a real
    // restaurant by mistake, that would be a kitchen's whole board — so both halves
    // check the location is synthetic before they touch anything.
    const real = await seedLocationWithMenu()
    await seedBusinessHours(real.id)
    await buildMenuSnapshot(real.id)
    const { order } = await seedPaidOrder(real.id)

    const result = await run(real.id)

    expect(result.outcome).toBe('failed')
    expect(result.failure).toMatch(/not synthetic/)
    expect(await ordersAt(real.id)).toHaveLength(1)
    expect((await readOrder(real.id, order.id)).status).toBe('NEW')
    await expect(cleanUpCanary(real.id)).rejects.toThrow(/not synthetic/)
    expect((await readOrder(real.id, order.id)).status).toBe('NEW')
  })

  it('never texts anyone about its own order — not the fan-out, not the stale-order alarm', async () => {
    const loc = await canaryLocation()
    await quietCanary()
    const staleSteps: string[] = []
    const stale: unknown[] = []
    sendOrderCreated.mockImplementation(async (orderId: string, locationId: string) => {
      // `order/created` has two listeners, and both are driven here.
      await deliverToFanOut(orderId, locationId)
      stale.push(await escalateStaleOrder({ orderId, locationId }, fakeStep(undefined, staleSteps)))
      return ['01JCANARYEVENT']
    })

    const result = await run(loc.id)

    expect(result.outcome).toBe('confirmed')
    expect(sendSms).not.toHaveBeenCalled()
    // The escalation saw a synthetic location and returned before its first sleep —
    // no wait, no page, and no Inngest executions spent on a timer for nobody.
    expect(stale).toEqual([{ orderId: result.orderId, outcome: 'synthetic' }])
    expect(staleSteps).toEqual([])
  })

  it('runs as the registered cron function, against the seeded canary org', async () => {
    // Through the harness, with the real resolver: `seed:canary`'s own org, found by
    // slug, exactly as production will find it.
    await seedCanary()
    await quietCanary()

    const out = await new InngestTestEngine({
      function: canary,
      steps: [{ id: 'wait-for-ticket', handler: () => null }],
    }).execute({ disableImmediateExecution: true })

    const err = out.error as { message?: string } | undefined
    expect(err?.message ?? '').toBe('')
    expect(out.result).toMatchObject({ outcome: 'confirmed', failure: null, alerted: false })
    expect(sendSms).not.toHaveBeenCalled()
  })
})

describe('findCanaryLocation', () => {
  it('finds the one synthetic location under the canary org', async () => {
    const orgSlug = `test-canary-${Date.now()}-${slugs++}`
    const seeded = await seedCanary({ orgSlug })
    expect(await findCanaryLocation(orgSlug)).toEqual({ ok: true, locationId: seeded.locationId })
  })

  it('does not take a real restaurant for the canary, whatever its org is called', async () => {
    const real = await seedLocation()
    const [org] = await db().select({ slug: organizations.slug }).from(organizations)
      .where(eq(organizations.id, real.orgId))
    const found = await findCanaryLocation(org.slug)
    expect(found.ok).toBe(false)
  })
})

describe('the printer heartbeat and a synthetic location', () => {
  it('says nothing about the canary location, which has no printer', async () => {
    await quietProbeWindow()
    const loc = await canaryLocation()

    const summary = await sweepPrinters(heartbeatStep([loc.id]))

    expect(summary.alerted).toEqual([])
    expect(sendSms).not.toHaveBeenCalled()
  })

  it('says nothing about a synthetic location even when it has a silent printer', async () => {
    // Verified, not assumed: the check is on the flag, so a printer row added to the
    // canary by mistake still cannot ring anyone.
    await quietProbeWindow()
    const loc = await canaryLocation()
    const printer = await seedPrinter(loc.id)
    await withLocation(loc.id, (tx) => tx.update(printers)
      .set({ lastSeenAt: new Date(Date.now() - 20 * MINUTE) })
      .where(eq(printers.id, printer.id)))

    const summary = await sweepPrinters(heartbeatStep([loc.id]))

    expect(summary.alerted).toEqual([])
    expect(sendSms).not.toHaveBeenCalled()
    const [after] = await withLocation(loc.id, (tx) => tx.select().from(printers)
      .where(eq(printers.id, printer.id)))
    expect(after.lastAlertAt).toBeNull()
  })
})
