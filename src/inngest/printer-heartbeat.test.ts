import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import type { GetStepTools } from 'inngest'
import { db } from '@/db/client'
import { printers, printJobs, printerProbeEvents } from '@/db/schema'
import { inngest as inngestClient } from '@/inngest/client'
import { withLocation } from '@/repo/scoped'
import {
  seedLocationWithMenu, seedBusinessHours, seedPaidOrder, seedPrinter, seedPrintJob,
  macAddress, type SeededMenu,
} from '@/test/seed'

/**
 * The alarm for the failure nobody notices: **the printer died and said nothing.**
 *
 * A jammed printer at least prints half a ticket. One that has been unplugged, or
 * whose wifi dropped, simply stops polling — and every order after that is taken,
 * charged and promised a time, with the ticket sitting in a queue nobody is
 * collecting. The tablet still shows the order, so the kitchen can survive this; what
 * they cannot do is find out about it on their own.
 *
 * Two silences are the same alarm and are deliberately one message:
 *
 * - no poll for three minutes, when the printer polls every few seconds;
 * - a ticket handed over and never confirmed — `delivered` and stuck, which is paper
 *   out or power pulled between the GET and the DELETE.
 *
 * And one that is not about a restaurant at all: a **burst of unknown serials**, which
 * is the only signal serial enumeration gives off.
 *
 * `sendSms` is mocked, as everywhere in this suite. Everything else is real.
 */
const { sendSms } = vi.hoisted(() => ({ sendSms: vi.fn() }))
vi.mock('@/lib/sms', () => ({ sendSms }))

const {
  printerHeartbeat, sweepPrinters, HEARTBEAT_CRON,
  PRINTER_SILENT_MS, STUCK_JOB_MS, ALERT_COOLDOWN_MS, PROBE_BURST_THRESHOLD,
} = await import('./printer-heartbeat')

const OPS_PHONE = '+15550008888'
const MINUTE = 60_000

let phones = 0

/** A restaurant with a phone of its own — see `order-created.test.ts` for why. */
async function restaurant({ open = true } = {}): Promise<SeededMenu> {
  const loc = await seedLocationWithMenu({
    name: 'Kashi',
    phoneE164: `+1555${String(3_000_000 + phones++)}`,
  })
  if (open) await seedBusinessHours(loc.id)
  return loc
}

/** A printer that last said hello `minutes` ago. `null` is one that never has. */
async function printerLastSeen(locationId: string, minutesAgo: number | null) {
  const printer = await seedPrinter(locationId)
  if (minutesAgo === null) return printer
  return withLocation(locationId, async (tx) => {
    const [row] = await tx.update(printers)
      .set({ lastSeenAt: new Date(Date.now() - minutesAgo * MINUTE) })
      .where(eq(printers.id, printer.id))
      .returning()
    return row
  })
}

/** A ticket that was collected and never confirmed, queued `minutes` ago. */
async function stuckTicket(locationId: string, minutesAgo: number) {
  const { order } = await seedPaidOrder(locationId)
  const job = await seedPrintJob(locationId, order.id, '*** STUCK ***')
  await withLocation(locationId, (tx) => tx.update(printJobs)
    .set({ status: 'delivered', createdAt: new Date(Date.now() - minutesAgo * MINUTE) })
    .where(eq(printJobs.id, job.id)))
  return job
}

function readPrinter(locationId: string, id: string) {
  return withLocation(locationId, async (tx) => {
    const [row] = await tx.select().from(printers).where(eq(printers.id, id))
    return row
  })
}

function textsTo(phone: string): string[] {
  return sendSms.mock.calls.filter(([to]) => to === phone).map(([, body]) => body as string)
}

/**
 * A `step` that runs the work, answering the location scan with this test's own
 * locations.
 *
 * The scan is a step precisely so it can be mocked, and it has to be: the shared
 * `test` branch holds thousands of locations left by every run that ever happened, and
 * a real sweep would open a transaction against each. One test below runs the real
 * lister to prove it is not a stub.
 */
function fakeStep(locationIds: string[], seen: string[] = []): GetStepTools<typeof inngestClient> {
  return {
    run: (id: string, fn: () => Promise<unknown>) => {
      seen.push(id)
      return id === 'list-locations' ? Promise.resolve(locationIds) : fn()
    },
  } as unknown as GetStepTools<typeof inngestClient>
}

/**
 * Ages every probe row out of the burst window.
 *
 * `printer_probe_events` is platform-global — a row in it belongs to no location, by
 * definition — so there is no scope to hide one test's rows from another's count, and
 * nothing tears the `test` branch down. This is the one place in this suite where a
 * test has to quieten a whole table, and it is safe because the suite is serial
 * (`fileParallelism: false`, and tests within a file run in order).
 *
 * UPDATE rather than DELETE because DELETE is not granted: the rows are evidence of an
 * enumeration attempt and nothing prunes them (see `drizzle/0016`).
 */
function clearProbeWindow(): Promise<unknown> {
  return db().execute(sql`
    update printer_probe_events
    set last_seen_at = now() - interval '2 hours', alerted_at = null`)
}

/** `n` distinct unknown serials, all seen just now. */
async function probes(n: number): Promise<void> {
  await db().insert(printerProbeEvents).values(
    Array.from({ length: n }, () => ({ serial: macAddress() })),
  )
}

beforeEach(() => {
  sendSms.mockReset()
  sendSms.mockResolvedValue(undefined)
  vi.stubEnv('OPS_ALERT_E164', OPS_PHONE)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('the printer heartbeat', () => {
  it('runs every five minutes, and is registered as a cron', () => {
    // A printer that polls every few seconds is three minutes silent long before this
    // notices; five minutes is the resolution, not the threshold.
    expect(HEARTBEAT_CRON).toBe('*/5 * * * *')
    expect(printerHeartbeat.opts.triggers).toEqual([{ cron: HEARTBEAT_CRON }])
    expect(PRINTER_SILENT_MS).toBe(3 * MINUTE)
    expect(STUCK_JOB_MS).toBe(10 * MINUTE)
    expect(ALERT_COOLDOWN_MS).toBe(60 * MINUTE)
  })

  it('texts the owner and us when an open kitchen stops polling', async () => {
    await clearProbeWindow()
    const loc = await restaurant()
    const printer = await printerLastSeen(loc.id, 7)

    const summary = await sweepPrinters(fakeStep([loc.id]))

    const expected = 'Serveside: at Kashi, the kitchen printer has not checked in for 7 min'
      + ' — check the printer.'
    expect(textsTo(loc.phoneE164)).toEqual([expected])
    expect(textsTo(OPS_PHONE)).toEqual([expected])
    expect(summary.alerted).toEqual([
      { locationId: loc.id, printerId: printer.id, silentMinutes: 7, stuckJobs: 0 },
    ])

    // Stamped **after** the texts went out, and it is what makes the next four runs in
    // the hour quiet.
    const after = await readPrinter(loc.id, printer.id)
    expect(after.lastAlertAt).toBeInstanceOf(Date)
    expect(Date.now() - after.lastAlertAt!.getTime()).toBeLessThan(MINUTE)
  })

  it('says nothing on the next run inside the hour', async () => {
    // The cron runs twelve times an hour. Without this the owner gets twelve identical
    // texts about one dead printer, and learns to ignore the thirteenth.
    await clearProbeWindow()
    const loc = await restaurant()
    const printer = await printerLastSeen(loc.id, 7)

    await sweepPrinters(fakeStep([loc.id]))
    const stamped = (await readPrinter(loc.id, printer.id)).lastAlertAt
    sendSms.mockClear()

    const summary = await sweepPrinters(fakeStep([loc.id]))

    expect(summary.alerted).toEqual([])
    expect(sendSms).not.toHaveBeenCalled()
    // And the clock was not restarted by the run that sent nothing, or the alert would
    // creep an hour later every time.
    expect((await readPrinter(loc.id, printer.id)).lastAlertAt).toEqual(stamped)
  })

  it('alerts again once the hour is up', async () => {
    await clearProbeWindow()
    const loc = await restaurant()
    const printer = await printerLastSeen(loc.id, 20)
    await withLocation(loc.id, (tx) => tx.update(printers)
      .set({ lastAlertAt: new Date(Date.now() - 61 * MINUTE) })
      .where(eq(printers.id, printer.id)))

    await sweepPrinters(fakeStep([loc.id]))

    expect(textsTo(loc.phoneE164)).toHaveLength(1)
    expect(textsTo(OPS_PHONE)).toHaveLength(1)
  })

  it('wakes nobody for a closed restaurant', async () => {
    // A printer switched off at closing time is not a fault, and 3am is not the moment
    // to tell anyone about it. The same ruling the stale-order alarm makes.
    await clearProbeWindow()
    const loc = await restaurant({ open: false })
    const printer = await printerLastSeen(loc.id, 45)

    const summary = await sweepPrinters(fakeStep([loc.id]))

    expect(summary.alerted).toEqual([])
    expect(sendSms).not.toHaveBeenCalled()
    // Not stamped either: the alert never happened, so the hour must not start here —
    // opening time would otherwise find the printer inside a cooldown it never earned.
    expect((await readPrinter(loc.id, printer.id)).lastAlertAt).toBeNull()
  })

  it('leaves a printer that is polling alone', async () => {
    await clearProbeWindow()
    const loc = await restaurant()
    await printerLastSeen(loc.id, 1)

    const summary = await sweepPrinters(fakeStep([loc.id]))

    expect(summary.alerted).toEqual([])
    expect(sendSms).not.toHaveBeenCalled()
  })

  it('leaves a printer that has never polled alone', async () => {
    // `lastSeenAt` is null for a unit that has been provisioned but not yet plugged in
    // at the restaurant. "Older than three minutes" is not true of it, and texting an
    // owner that the printer sitting in its box is offline is how the alarm loses its
    // credibility before the first real one.
    await clearProbeWindow()
    const loc = await restaurant()
    await printerLastSeen(loc.id, null)

    const summary = await sweepPrinters(fakeStep([loc.id]))

    expect(summary.alerted).toEqual([])
    expect(sendSms).not.toHaveBeenCalled()
  })

  it('reports a ticket that was collected and never printed', async () => {
    // `delivered` means the bytes left us; `confirmed` means the printer says it came
    // out. A job stuck at the first for ten minutes is paper out or power pulled in
    // between — the case an owner phones about, found before they do.
    await clearProbeWindow()
    const loc = await restaurant()
    const printer = await printerLastSeen(loc.id, 0)
    await stuckTicket(loc.id, 15)

    const summary = await sweepPrinters(fakeStep([loc.id]))

    const expected = 'Serveside: at Kashi, 1 ticket may not have printed — check the printer.'
    expect(textsTo(loc.phoneE164)).toEqual([expected])
    expect(textsTo(OPS_PHONE)).toEqual([expected])
    expect(summary.alerted).toEqual([
      { locationId: loc.id, printerId: printer.id, silentMinutes: null, stuckJobs: 1 },
    ])

    // **Not requeued.** A job put back in the queue would be collected and printed
    // again, and a duplicate ticket is a duplicate dinner — the printer may well have
    // printed it and died before saying so.
    const [job] = await withLocation(loc.id, (tx) =>
      tx.select().from(printJobs).where(eq(printJobs.status, 'delivered')))
    expect(job).toBeDefined()
  })

  it('says both things in one message when both are true', async () => {
    await clearProbeWindow()
    const loc = await restaurant()
    await printerLastSeen(loc.id, 9)
    await stuckTicket(loc.id, 12)
    await stuckTicket(loc.id, 30)

    await sweepPrinters(fakeStep([loc.id]))

    // One text, not two: two alarms an hour about one dead printer is how an owner
    // learns to ignore both.
    expect(textsTo(loc.phoneE164)).toEqual([
      'Serveside: at Kashi, the kitchen printer has not checked in for 9 min'
      + ' and 2 tickets may not have printed — check the printer.',
    ])
  })

  it('ignores a ticket that was only just handed over', async () => {
    await clearProbeWindow()
    const loc = await restaurant()
    await printerLastSeen(loc.id, 0)
    await stuckTicket(loc.id, 2)

    const summary = await sweepPrinters(fakeStep([loc.id]))

    expect(summary.alerted).toEqual([])
    expect(sendSms).not.toHaveBeenCalled()
  })

  it('carries on past a location it cannot read, and ends the run red naming it', async () => {
    // Whatever goes wrong for one restaurant must not stop every other restaurant's
    // printer being checked — the same ruling the unsnooze cron makes.
    await clearProbeWindow()
    const loc = await restaurant()
    await printerLastSeen(loc.id, 7)

    await expect(sweepPrinters(fakeStep(['not-a-location', loc.id])))
      .rejects.toThrow(/not-a-location/)

    expect(textsTo(loc.phoneE164)).toHaveLength(1)
  })

  it('scans every location for real when nothing mocks the list', async () => {
    const loc = await restaurant()
    const { listLocationIds } = await import('./unsnooze')
    expect(await listLocationIds()).toContain(loc.id)
  })
})

describe('the unprovisioned-serial burst', () => {
  it('tells us when a spread of unknown serials starts arriving', async () => {
    // The serial is the whole credential on an unauthenticated route, so guessing one
    // is the attack, and a spread of *distinct* unknown serials is the only signal it
    // gives off — one mis-provisioned printer repeats one MAC forever.
    await clearProbeWindow()
    await probes(PROBE_BURST_THRESHOLD + 1)

    const summary = await sweepPrinters(fakeStep([]))

    expect(summary.probeBurst).toMatchObject({ serials: PROBE_BURST_THRESHOLD + 1, alerted: true })
    // Us only. There is no restaurant to tell: by definition these serials belong to
    // nobody.
    expect(textsTo(OPS_PHONE)).toEqual([
      `Serveside: ${PROBE_BURST_THRESHOLD + 1} unknown printer serials polled in the last 10 min`
      + ' — possible serial sweep.',
    ])
  })

  it('says nothing again for an hour', async () => {
    await clearProbeWindow()
    await probes(PROBE_BURST_THRESHOLD + 1)

    await sweepPrinters(fakeStep([]))
    sendSms.mockClear()
    await probes(PROBE_BURST_THRESHOLD + 1)

    const summary = await sweepPrinters(fakeStep([]))

    // The sweep is still happening and the count still says so — but a text a minute
    // for an hour is a phone nobody looks at.
    expect(summary.probeBurst).toMatchObject({ alerted: false })
    expect(sendSms).not.toHaveBeenCalled()
  })

  it('stays quiet for one mis-provisioned printer knocking over and over', async () => {
    // The honest case this must not cry wolf about: an installer typed the MAC wrong,
    // and one unknown serial polls every few seconds all afternoon. One row, however
    // many polls.
    await clearProbeWindow()
    const serial = macAddress()
    for (let i = 0; i < PROBE_BURST_THRESHOLD + 5; i++) {
      await db().insert(printerProbeEvents).values({ serial })
        .onConflictDoUpdate({
          target: printerProbeEvents.serial,
          set: { lastSeenAt: new Date(), polls: sql`${printerProbeEvents.polls} + 1` },
        })
    }

    const summary = await sweepPrinters(fakeStep([]))

    expect(summary.probeBurst).toMatchObject({ serials: 1, alerted: false })
    expect(sendSms).not.toHaveBeenCalled()
  })
})
