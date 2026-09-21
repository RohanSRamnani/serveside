import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq, gt, sql } from 'drizzle-orm'
import type { GetStepTools } from 'inngest'
import { db } from '@/db/client'
import { printers, printJobs, printerProbeEvents } from '@/db/schema'
import { inngest as inngestClient } from '@/inngest/client'
import { withLocation } from '@/repo/scoped'
import {
  seedLocationWithMenu, seedBusinessHours, seedPaidOrder, seedPrinter, seedPrintJob,
  macAddress, quietProbeWindow, type SeededMenu,
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
  PRINTER_SILENT_MS, STUCK_JOB_MS, STUCK_JOB_MAX_AGE_MS, ALERT_COOLDOWN_MS,
} = await import('./printer-heartbeat')
const { PROBE_BURST_THRESHOLD, PROBE_RETENTION_MS, recordProbe } = await import('@/domain/printer-probes')

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

/** Ages every probe row out of the burst window — shared, and `seed.ts` says why. */
const clearProbeWindow = quietProbeWindow

/**
 * `n` distinct unknown serials, all seen just now. Inserted directly rather than
 * through `recordProbe`, because `recordProbe` refuses to grow the table past the
 * threshold — which is the behaviour under test in its own case, not a way to seed one.
 */
async function probes(n: number): Promise<void> {
  await db().insert(printerProbeEvents).values(
    Array.from({ length: n }, () => ({ serial: macAddress() })),
  )
}

/** How many serials are inside the burst window right now. */
async function windowSize(): Promise<number> {
  const rows = await db().select({ id: printerProbeEvents.id }).from(printerProbeEvents)
    .where(gt(printerProbeEvents.lastSeenAt, new Date(Date.now() - 10 * MINUTE)))
  return rows.length
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
    // The upper bound is not tidiness — see the test below, and the constant's own
    // note: nothing ever moves a job off `delivered`, so without it the alarm would
    // have no way to stop.
    expect(STUCK_JOB_MAX_AGE_MS).toBe(6 * 60 * MINUTE)
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

  it('gives up on a ticket that is hours old, so the alarm can stop', async () => {
    // **The alarm has to be able to clear itself.** A job that failed to print stays
    // at `delivered` for good — the route refuses to requeue it, deliberately — and
    // nothing else moves it, so an unbounded "older than ten minutes" would match the
    // same row for the life of the database: one jammed ticket on a Tuesday, an owner
    // and an ops phone texted every open hour, forever. That is exactly the
    // muted-alarm failure this file exists to avoid, delivered by the file itself.
    await clearProbeWindow()
    const loc = await restaurant()
    await printerLastSeen(loc.id, 0)
    await stuckTicket(loc.id, 7 * 60)

    const summary = await sweepPrinters(fakeStep([loc.id]))

    expect(summary.alerted).toEqual([])
    expect(sendSms).not.toHaveBeenCalled()
  })

  it('still alerts while the stuck ticket is inside the window it can act on', async () => {
    // The control for the bound above: five hours in, the order may still be on a
    // board and the customer may still be coming, so it is worth a text.
    await clearProbeWindow()
    const loc = await restaurant()
    await printerLastSeen(loc.id, 0)
    await stuckTicket(loc.id, 5 * 60)

    await sweepPrinters(fakeStep([loc.id]))

    expect(textsTo(loc.phoneE164)).toHaveLength(1)
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

  it('still tells the owner when our own number is unreachable, and does not repeat itself', async () => {
    // Both phones are one alert, and the stamp answers "has this alarm been raised",
    // not "did every leg succeed". Without that, a blank `OPS_ALERT_E164` or a number
    // that has replied STOP would make Inngest retry the step and text a restaurant
    // owner four times about one dead printer — and retrying would not fix either
    // cause. The run still ends red, which is how we find out ours is broken.
    await clearProbeWindow()
    const loc = await restaurant()
    const printer = await printerLastSeen(loc.id, 7)
    sendSms.mockImplementation((to: string) =>
      (to === OPS_PHONE ? Promise.reject(new Error('twilio said no')) : Promise.resolve()))

    await expect(sweepPrinters(fakeStep([loc.id]))).rejects.toThrow(/ops: twilio said no/)

    expect(textsTo(loc.phoneE164)).toHaveLength(1)
    expect((await readPrinter(loc.id, printer.id)).lastAlertAt).toBeInstanceOf(Date)

    // The next eleven runs this hour say nothing more — but they also come back
    // green, which is the whole reason the failure above must not be reported from
    // inside the step. See the test below.
    sendSms.mockClear()
    await sweepPrinters(fakeStep([loc.id]))
    expect(sendSms).not.toHaveBeenCalled()
  })

  it('stays red on a retry that replays the step instead of re-running it', async () => {
    // **The failure that would otherwise disappear.** Inngest retries a failed step,
    // and a retry of this one finds the cooldown it just stamped, alerts nobody and
    // succeeds — so reporting "ops never got the text" from inside the step would turn
    // a permanently unreachable OPS_ALERT_E164 into a green run, every time, and we
    // would never learn our own alarm has no way to reach us.
    //
    // So the send failure is carried out in the step's *result* and the run is failed
    // from the function body. Here the step is replayed from memoized state — exactly
    // what Inngest does on a function-level retry — and the run still ends red without
    // re-sending anything.
    const memoized = {
      alerted: [{ locationId: 'loc-1', printerId: 'p-1', silentMinutes: 7, stuckJobs: 0 }],
      unraised: [],
      undelivered: ['loc-1: ops: twilio said no'],
    }
    const replay = {
      run: (id: string, fn: () => Promise<unknown>) => {
        if (id === 'list-locations') return Promise.resolve(['loc-1'])
        if (id === 'alert-locations') return Promise.resolve(memoized)
        return fn()
      },
    } as unknown as GetStepTools<typeof inngestClient>

    await clearProbeWindow()
    await expect(sweepPrinters(replay)).rejects.toThrow(/ops: twilio said no/)
    // Nothing re-sent: the step that did the texting was never re-run.
    expect(sendSms).not.toHaveBeenCalled()
  })

  it('does not start the cooldown when neither phone could be reached', async () => {
    // Twilio down is the one case where retrying is exactly right: nobody was told
    // anything, so the alarm has not been raised and the hour must not start.
    await clearProbeWindow()
    const loc = await restaurant()
    const printer = await printerLastSeen(loc.id, 7)
    sendSms.mockRejectedValue(new Error('twilio is down'))

    await expect(sweepPrinters(fakeStep([loc.id]))).rejects.toThrow(/owner: .*; ops: /)
    expect((await readPrinter(loc.id, printer.id)).lastAlertAt).toBeNull()

    // And once it is back, the alert goes out on the very next run.
    sendSms.mockReset()
    sendSms.mockResolvedValue(undefined)
    await sweepPrinters(fakeStep([loc.id]))
    expect(textsTo(loc.phoneE164)).toHaveLength(1)
    expect(textsTo(OPS_PHONE)).toHaveLength(1)
  })

  it('alerts two restaurants in one tick, each about its own kitchen', async () => {
    // The plain multi-location case the rest of this file was missing: every alarm here
    // reads one location at a time, so "it works for one" says nothing about a platform
    // with two. Each owner must get their own message and nobody else's.
    await clearProbeWindow()
    const kashi = await restaurant()
    const other = await seedLocationWithMenu({
      name: 'Bodega', phoneE164: `+1555${String(3_000_000 + phones++)}`,
    })
    await seedBusinessHours(other.id)
    const kashiPrinter = await printerLastSeen(kashi.id, 7)
    const otherPrinter = await printerLastSeen(other.id, 12)

    const summary = await sweepPrinters(fakeStep([kashi.id, other.id]))

    expect(textsTo(kashi.phoneE164)).toEqual([
      'Serveside: at Kashi, the kitchen printer has not checked in for 7 min — check the printer.',
    ])
    expect(textsTo(other.phoneE164)).toEqual([
      'Serveside: at Bodega, the kitchen printer has not checked in for 12 min — check the printer.',
    ])
    // Ours gets both, because we are the one who has to go and look at two of them.
    expect(textsTo(OPS_PHONE)).toHaveLength(2)
    expect(summary.alerted).toEqual([
      { locationId: kashi.id, printerId: kashiPrinter.id, silentMinutes: 7, stuckJobs: 0 },
      { locationId: other.id, printerId: otherPrinter.id, silentMinutes: 12, stuckJobs: 0 },
    ])
  })

  it('never loses a half-sent alert because another restaurant failed in the same tick', async () => {
    // **The masking bug, in the shape it actually happens.** `OPS_ALERT_E164` is one
    // number for the whole platform, so a broken one fails the ops leg at *every*
    // alerting restaurant at once. Here A's own number refuses as well (it replied
    // STOP), so A raises nothing, while B's alert reaches its owner and not us.
    //
    // Reporting A by throwing out of the step would discard B — and B can never be
    // rediscovered, because B stamped its cooldown on the way past. The step retry
    // would find B quiet, A's transient failure cleared, and report a green run with a
    // broken ops number at every restaurant on the platform.
    await clearProbeWindow()
    const a = await restaurant()
    const b = await seedLocationWithMenu({
      name: 'Bodega', phoneE164: `+1555${String(3_000_000 + phones++)}`,
    })
    await seedBusinessHours(b.id)
    const aPrinter = await printerLastSeen(a.id, 7)
    const bPrinter = await printerLastSeen(b.id, 9)
    sendSms.mockImplementation((to: string) => (to === OPS_PHONE || to === a.phoneE164
      ? Promise.reject(new Error(to === OPS_PHONE ? 'ops number is dead' : 'owner replied STOP'))
      : Promise.resolve()))

    // Attempt one: the run is red and **both** restaurants are named, not just the
    // one that threw.
    let memoized: unknown
    const capturing = {
      run: (id: string, fn: () => Promise<unknown>) => {
        if (id === 'list-locations') return Promise.resolve([a.id, b.id])
        if (id === 'alert-locations') return fn().then((value) => { memoized = value; return value })
        return fn()
      },
    } as unknown as GetStepTools<typeof inngestClient>

    const first = await sweepPrinters(capturing).catch((err: Error) => err.message)
    expect(first).toContain('ops number is dead')
    expect(first).toContain(b.id)
    expect(first).toContain(a.id)

    // A raised nothing, so it is not in a cooldown and the next tick will try it
    // again. B reached somebody, so it *is* — which is precisely why its failure had
    // to be carried rather than thrown away.
    expect((await readPrinter(a.id, aPrinter.id)).lastAlertAt).toBeNull()
    expect((await readPrinter(b.id, bPrinter.id)).lastAlertAt).toBeInstanceOf(Date)

    // The retry: Inngest replays the memoized step rather than re-running it, so this
    // is the attempt the old code turned green. B's failure is still in the accounting
    // and the run is still red.
    sendSms.mockClear()
    const replay = {
      run: (id: string, fn: () => Promise<unknown>) => {
        if (id === 'list-locations') return Promise.resolve([a.id, b.id])
        if (id === 'alert-locations') return Promise.resolve(memoized)
        return fn()
      },
    } as unknown as GetStepTools<typeof inngestClient>

    const retried = await sweepPrinters(replay).catch((err: Error) => err.message)
    expect(retried).toContain('ops number is dead')
    expect(retried).toContain(b.id)
    // And nothing was re-sent: the step that did the texting never ran again.
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
    //
    // "At least", because the count really is a floor and not a measurement: the poll
    // route stops recording new serials once the window is over threshold, so this
    // reads the same whether twenty-one MACs were tried or ten million. Claiming an
    // exact number would be claiming we measured something we deliberately stopped
    // measuring.
    expect(textsTo(OPS_PHONE)).toEqual([
      `Serveside: at least ${PROBE_BURST_THRESHOLD + 1} unknown printer serials polled in the last 10 min`
      + ' — possible serial sweep.',
    ])
  })

  it('stops recording new serials once the alarm is already earned', async () => {
    // **The cap that keeps this from being a durable, attacker-chosen table.** The MAC
    // space a sweep walks is tens of millions; a row per guess would be tens of
    // millions of rows, and the cleanup would be a migration written under pressure.
    // Past the threshold the alarm has been earned and another serial adds nothing, so
    // the table simply stops listening.
    await clearProbeWindow()
    await probes(PROBE_BURST_THRESHOLD + 1)
    const before = await windowSize()

    const fresh = macAddress()
    await recordProbe(fresh)

    expect(await windowSize()).toBe(before)
    expect(await db().select().from(printerProbeEvents)
      .where(eq(printerProbeEvents.serial, fresh))).toHaveLength(0)
  })

  it('keeps counting a serial it has already seen, even over the threshold', async () => {
    // The `or exists` half of the cap: bumping a row that is already there costs no
    // growth at all, and `polls` on a known-bad serial is the thing that says "one
    // mis-provisioned printer" rather than "a sweep".
    await clearProbeWindow()
    const known = macAddress()
    await recordProbe(known)
    await probes(PROBE_BURST_THRESHOLD + 1)

    await recordProbe(known)

    const [row] = await db().select().from(printerProbeEvents)
      .where(eq(printerProbeEvents.serial, known))
    expect(row.polls).toBe(2)
  })

  it('sweeps rows older than the retention window, on the same cron', async () => {
    // Nothing else prunes this table, and "nothing prunes it" is not an answer for the
    // one table an unauthenticated stranger can add rows to.
    await clearProbeWindow()
    const stale = macAddress()
    await db().insert(printerProbeEvents).values({
      serial: stale,
      firstSeenAt: new Date(Date.now() - PROBE_RETENTION_MS - MINUTE),
      lastSeenAt: new Date(Date.now() - PROBE_RETENTION_MS - MINUTE),
    })
    const recent = macAddress()
    await recordProbe(recent)

    const summary = await sweepPrinters(fakeStep([]))

    expect(summary.probeBurst.pruned).toBeGreaterThanOrEqual(1)
    expect(await db().select().from(printerProbeEvents)
      .where(eq(printerProbeEvents.serial, stale))).toHaveLength(0)
    // And it does not touch what is still inside the window — including the row that
    // would have been the next alert.
    expect(await db().select().from(printerProbeEvents)
      .where(eq(printerProbeEvents.serial, recent))).toHaveLength(1)
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
    for (let i = 0; i < PROBE_BURST_THRESHOLD + 5; i++) await recordProbe(serial)

    const summary = await sweepPrinters(fakeStep([]))

    expect(summary.probeBurst).toMatchObject({ serials: 1, alerted: false })
    expect(sendSms).not.toHaveBeenCalled()
  })
})
