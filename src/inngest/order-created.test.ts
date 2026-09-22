import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { InngestTestEngine } from '@inngest/test'
import type { GetStepTools } from 'inngest'
import { inngest as inngestClient } from '@/inngest/client'
import { printJobs } from '@/db/schema'
import { withLocation } from '@/repo/scoped'
import { ordersRepo } from '@/repo/orders-repo'
import { seedLocationWithMenu, seedPaidOrder } from '@/test/seed'

/**
 * The fan-out is the promise this whole repo makes: money landed, so a human finds
 * out. It keeps that promise **twice over, independently** — a ticket in the print
 * queue and a text to the owner's phone — and the entire design is that one of those
 * failing must not take the other with it. A kitchen with a jammed printer still gets
 * the SMS; a kitchen whose Twilio account is out of credit still gets the ticket.
 *
 * So the tests that matter here are the failure ones, and they are written as
 * *observable side effects* rather than as step bookkeeping: the row is in
 * `print_jobs` or it is not, and the phone rang or it did not.
 *
 * Two things are mocked and nothing else:
 *
 * - `sendSms`, because a test that reaches Twilio spends money and fails in CI.
 * - `renderTicket`, which stays **real** (the stored payload has to be the real
 *   ticket) but is wrapped in a spy so one test can make the print leg — and only the
 *   print leg — fail.
 *
 * The database is real. A print job that RLS would refuse, or a ticket rendered from
 * an order the worker cannot see, is exactly the bug this file exists to catch.
 */
const { sendSms } = vi.hoisted(() => ({ sendSms: vi.fn() }))
vi.mock('@/lib/sms', () => ({ sendSms }))

vi.mock('@/domain/ticket', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/domain/ticket')>()
  return { ...actual, renderTicket: vi.fn(actual.renderTicket) }
})

const { renderTicket } = await import('@/domain/ticket')
const { orderCreated, fanOut: fanOutHandler } = await import('./order-created')

/** Pinned so the expected SMS body is a literal, not a restatement of the code. */
const FEED_URL = 'https://serveside.test/feed'
/** What `seedPaidOrder` totals to: (1800 + 50) × 2 + 324 tax + 500 tip. */
const ORDER_TOTAL = '$45.24'

let phones = 0

/**
 * A restaurant with a phone number of its own.
 *
 * `seedLocation` gives every location the same number, which would be fine if runs
 * ended when `execute()` returns — they do not. A step the harness re-issued can land
 * after the test that started it has finished, so a test asserting "nobody was
 * texted" needs to be able to tell *its* silence from the previous test's echo.
 */
function restaurant() {
  return seedLocationWithMenu({ phoneE164: `+1555${String(1_000_000 + phones++)}` })
}

/** Every text sent to one restaurant, ignoring any still in flight for another. */
function textsTo(phoneE164: string): unknown[][] {
  return sendSms.mock.calls.filter(([to]) => to === phoneE164)
}

/** One run of the fan-out, exactly as the orchestrator would deliver it. */
function fanOut(orderId: string, locationId: string) {
  return new InngestTestEngine({ function: orderCreated }).execute({
    events: [{ name: 'order/created', data: { orderId, locationId } }],
    disableImmediateExecution: true,
  })
}

/**
 * Wait for a side effect that is still in flight.
 *
 * Two properties of running parallel steps make this necessary, and both are
 * faithful to production rather than being papered over:
 *
 * 1. **The harness settles the run at the first errored step**, while the other leg
 *    is still mid-write. The real orchestrator runs each step as its own queue item
 *    and never cancels a sibling — so "the other leg finished anyway" is exactly the
 *    property under test, and it is worth waiting a beat for.
 * 2. **Steps are at-least-once.** The harness re-executes a step whose result has not
 *    yet landed in its shared state, and Inngest itself makes the same promise: a
 *    step may run twice. That is why the print leg dedupes in the database, and why
 *    the SMS leg's call *count* is never pinned here — only what it was called with.
 */
function eventually(assertion: () => void | Promise<void>): Promise<void> {
  return vi.waitFor(assertion, { timeout: 10_000, interval: 50 })
}

/** The run's failure, flattened — the engine hands back a serialized error, not an `Error`. */
function failure(out: { error?: unknown }): string {
  const err = out.error as { name?: string; message?: string } | undefined
  return err ? `${err.name ?? 'Error'}: ${err.message ?? ''}` : ''
}

/** Every ticket queued for one order. Scoped, because `print_jobs` is under RLS. */
function jobsFor(locationId: string, orderId: string) {
  return withLocation(locationId, (tx) =>
    tx.select().from(printJobs).where(eq(printJobs.orderId, orderId)))
}

/** The ticket the renderer produces for this order — what the queued payload must equal. */
async function ticketFor(locationId: string, orderId: string, timezone: string): Promise<string> {
  const order = await withLocation(locationId, (tx) => ordersRepo(tx).getWithItems(orderId))
  if (!order) throw new Error('seeded order is not readable in its own location')
  return renderTicket({ ...order, timezone })
}

beforeEach(() => {
  vi.clearAllMocks()
  // `mockReset` on a `vi.fn(impl)` puts the original implementation back — here, the
  // real renderer, after a test has made it throw.
  vi.mocked(renderTicket).mockReset()
  sendSms.mockReset()
  sendSms.mockResolvedValue(undefined)
  vi.stubEnv('FEED_URL', FEED_URL)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('orderCreated fan-out', () => {
  it('queues the kitchen ticket and texts the owner', async () => {
    const loc = await restaurant()
    const { order } = await seedPaidOrder(loc.id)

    const out = await fanOut(order.id, loc.id)
    expect(failure(out)).toBe('')

    const [job] = await jobsFor(loc.id, order.id)
    expect(job).toBeDefined()
    // The payload is the **finished ticket**, stored verbatim — not a reference to the
    // order. A reprint hours later must reproduce what printed, not re-render against
    // a menu that has moved.
    expect(job.payload).toBe(await ticketFor(loc.id, order.id, loc.timezone))
    expect(job.payload).toContain(order.shortCode)
    expect(job.status).toBe('queued')
    expect(job.locationId).toBe(loc.id)

    // The owner's phone, not the customer's, and money formatted from integer cents.
    expect(sendSms).toHaveBeenCalledWith(
      loc.phoneE164,
      `New order ${order.shortCode} — ${ORDER_TOTAL}. Feed: ${FEED_URL}`,
    )

    // Both legs are `step.run`s, which is not decoration: a step is the unit Inngest
    // retries and memoizes, so two steps is what buys the two legs separate retries.
    expect(out.ctx.step.run).toHaveBeenCalledWith('queue-print-job', expect.any(Function))
    expect(out.ctx.step.run).toHaveBeenCalledWith('sms-owner', expect.any(Function))
  })

  it('still queues the ticket when the SMS fails', async () => {
    // Twilio out of credit, a number that has opted out, an outage. The kitchen must
    // still get its ticket — this is the whole reason the two are separate steps.
    const loc = await restaurant()
    const { order } = await seedPaidOrder(loc.id)
    sendSms.mockRejectedValue(new Error('twilio is down'))

    const out = await fanOut(order.id, loc.id)

    // And the run is reported failed, so the failed leg is visible rather than
    // swallowed: a half-done fan-out that reads as success is an SMS nobody misses
    // until the owner asks why they were never told.
    expect(failure(out)).toContain('twilio is down')
    expect(sendSms).toHaveBeenCalled()

    // The ticket lands regardless — the assertion this whole file exists for.
    await eventually(async () => {
      const jobs = await jobsFor(loc.id, order.id)
      expect(jobs).toHaveLength(1)
      expect(jobs[0].payload).toContain(order.shortCode)
    })
  })

  it('still texts the owner when the print job fails', async () => {
    // The other direction, and the one that actually saves a service: the printer
    // queue is unreachable or the ticket cannot be rendered, and the owner's phone is
    // the only thing left that tells a human an order exists.
    const loc = await restaurant()
    const { order } = await seedPaidOrder(loc.id)
    // Every call, not just the first: a step that is retried must find the leg still
    // broken, or "no ticket was queued" would only be true of the first attempt.
    vi.mocked(renderTicket).mockImplementation(() => { throw new Error('renderer blew up') })

    const out = await fanOut(order.id, loc.id)

    expect(failure(out)).toContain('renderer blew up')
    await eventually(() => {
      expect(sendSms).toHaveBeenCalledWith(
        loc.phoneE164,
        `New order ${order.shortCode} — ${ORDER_TOTAL}. Feed: ${FEED_URL}`,
      )
    })
    expect(await jobsFor(loc.id, order.id)).toHaveLength(0)
  })

  it('queues one ticket, not two, when the same order fans out twice', async () => {
    // The webhook re-fires the fan-out when it cannot prove its own 200 was received,
    // and Inngest's event-id dedupe only covers 24 hours. A second ticket is a second
    // dinner, so the print leg checks the database rather than trusting the queue.
    const loc = await restaurant()
    const { order } = await seedPaidOrder(loc.id)

    await fanOut(order.id, loc.id)
    const [first] = await jobsFor(loc.id, order.id)
    expect(first).toBeDefined()

    const second = await fanOut(order.id, loc.id)
    expect(failure(second)).toBe('')

    const jobs = await jobsFor(loc.id, order.id)
    expect(jobs).toHaveLength(1)
    expect(jobs[0].id).toBe(first.id)

    // Named rather than hidden: the SMS leg is **not** deduped. A duplicate text is a
    // nuisance; a duplicate ticket is food. Making the text conditional on the print
    // job would couple the two legs, which is the one thing this function may not do.
    // So every text went out, and every one of them is about this order.
    expect(textsTo(loc.phoneE164).length).toBeGreaterThanOrEqual(2)
    for (const call of textsTo(loc.phoneE164)) {
      expect(call).toEqual([loc.phoneE164, `New order ${order.shortCode} — ${ORDER_TOTAL}. Feed: ${FEED_URL}`])
    }
  })

  it('refuses an event that does not name an order, before it touches a query', async () => {
    // The payload arrives over HTTP from the orchestrator, so it is input, not a
    // promise. A malformed uuid reaching Postgres is a 22P02 that poisons the whole
    // transaction — the same reason the Stripe webhook shape-checks its metadata.
    const loc = await restaurant()

    const out = await fanOut('not-a-uuid', loc.id)

    expect(failure(out)).toMatch(/order\/created/)
    expect(textsTo(loc.phoneE164)).toHaveLength(0)
  })

  it('writes nothing for an order that is not in the location the event names', async () => {
    // Tenancy, enforced by RLS rather than by a WHERE clause: opened against the wrong
    // location the order is simply not there, so there is nothing to print and nobody
    // to text. A ticket queued here would be one restaurant's order on another
    // restaurant's printer.
    const locA = await restaurant()
    const locB = await restaurant()
    const { order } = await seedPaidOrder(locA.id)

    const out = await fanOut(order.id, locB.id)

    expect(await jobsFor(locA.id, order.id)).toHaveLength(0)
    expect(await jobsFor(locB.id, order.id)).toHaveLength(0)
    expect(textsTo(locA.phoneE164)).toHaveLength(0)
    expect(textsTo(locB.phoneE164)).toHaveLength(0)
    expect(failure(out)).toContain(order.id)
  })
})

/**
 * The fan-out called directly, with a `step` of our own making.
 *
 * This is the only way to reach two things at all. `@inngest/test@1.0.0` reports a run
 * as failed the moment a step errors and never resumes the function body, and a mocked
 * failed step is swallowed rather than delivered — so the throw that turns a broken leg
 * into a failed run, and the value the function returns, are both invisible to the
 * tests above. A fake `step` is two lines and reaches both.
 *
 * It is also the crisper place to race the print leg against itself: no harness in the
 * middle re-issuing steps of its own accord.
 */
describe('fanOut, driven directly', () => {
  /** A `step` that simply runs the work, except for the leg named as broken. */
  function step(broken?: 'queue-print-job' | 'sms-owner', reason: unknown = new Error('leg is down')) {
    return {
      run: (id: string, fn: () => Promise<unknown>) => (id === broken ? Promise.reject(reason) : fn()),
    } as unknown as GetStepTools<typeof inngestClient>
  }

  it('returns the queued ticket when both legs land', async () => {
    const loc = await restaurant()
    const { order } = await seedPaidOrder(loc.id)

    const result = await fanOutHandler({ orderId: order.id, locationId: loc.id }, step())

    const [job] = await jobsFor(loc.id, order.id)
    expect(result).toEqual({ orderId: order.id, printJobId: job.id, alreadyQueued: false })
  })

  it('fails the run when the SMS leg is dead, having queued the ticket anyway', async () => {
    // The assertion the survived mutation was hiding: delete the throw and this
    // resolves instead of rejecting, so a fan-out that half happened reports success.
    const loc = await restaurant()
    const { order } = await seedPaidOrder(loc.id)

    await expect(fanOutHandler({ orderId: order.id, locationId: loc.id }, step('sms-owner', new Error('twilio is down'))))
      .rejects.toThrow(`order ${order.id} fan-out incomplete — sms-owner: twilio is down`)

    expect(await jobsFor(loc.id, order.id)).toHaveLength(1)
  })

  it('fails the run when the print leg is dead, having texted the owner anyway', async () => {
    const loc = await restaurant()
    const { order } = await seedPaidOrder(loc.id)

    await expect(fanOutHandler({ orderId: order.id, locationId: loc.id }, step('queue-print-job', new Error('db is down'))))
      .rejects.toThrow(`order ${order.id} fan-out incomplete — queue-print-job: db is down`)

    expect(await jobsFor(loc.id, order.id)).toHaveLength(0)
    expect(textsTo(loc.phoneE164)).toHaveLength(1)
  })

  it('names both legs when both broke, and survives a rejection that is not an Error', async () => {
    // "The fan-out failed" is not an actionable sentence at 7pm on a Friday: which half
    // reached a human is the first thing anyone needs to know. And a `throw 'string'`
    // from a dependency must not turn the report into `[object Object]`.
    const loc = await restaurant()
    const { order } = await seedPaidOrder(loc.id)
    sendSms.mockRejectedValue('twilio said no')

    await expect(fanOutHandler({ orderId: order.id, locationId: loc.id }, step('queue-print-job', 'db said no')))
      .rejects.toThrow(`order ${order.id} fan-out incomplete — queue-print-job: db said no; sms-owner: twilio said no`)
  })

  it('queues one ticket when two fan-outs of the same order run at the same time', async () => {
    // **The race the advisory lock exists for**, run for real rather than argued about.
    // Two runs in flight at once is not exotic: Inngest is at-least-once, so a redelivery
    // can land on top of a run that has not finished, and the check-then-insert in the
    // print leg is two statements that READ COMMITTED will happily interleave.
    //
    // Sequential fan-outs cannot show this — the first row is committed before the
    // second one looks — which is why they are concurrent here.
    const loc = await restaurant()
    const { order } = await seedPaidOrder(loc.id)

    await Promise.all([
      fanOutHandler({ orderId: order.id, locationId: loc.id }, step()),
      fanOutHandler({ orderId: order.id, locationId: loc.id }, step()),
    ])

    expect(await jobsFor(loc.id, order.id)).toHaveLength(1)
  })
})
