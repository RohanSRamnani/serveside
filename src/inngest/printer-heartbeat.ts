import type { GetStepTools } from 'inngest'
import { and, count, eq, gt, inArray, lt, max } from 'drizzle-orm'
import { db } from '@/db/client'
import { locations, printers, printJobs, printerProbeEvents } from '@/db/schema'
import { withLocation } from '@/repo/scoped'
import { isOpenAt } from '@/domain/hours'
import { sendSms } from '@/lib/sms'
import { env } from '@/lib/env'
import { inngest } from './client'
import { listLocationIds } from './unsnooze'

/**
 * The alarm for the failure nobody notices: **the printer died and said nothing.**
 *
 * A jammed printer at least prints half a ticket and someone sees it. A printer that
 * has been unplugged, or whose wifi dropped, simply stops polling — and every order
 * after that is taken, charged and promised a time, with its ticket sitting in a queue
 * nobody is collecting. The tablet still shows the orders, so a kitchen can survive
 * this; what they cannot do is notice it, because nothing about a silent printer looks
 * different from a quiet Tuesday.
 *
 * Two silences are the same alarm, and are deliberately **one message**:
 *
 * - no poll for {@link PRINTER_SILENT_MS}, when a Star unit polls every few seconds;
 * - a ticket handed over and never confirmed ({@link STUCK_JOB_MS} at `delivered`),
 *   which is paper out or power pulled between the GET and the DELETE.
 *
 * Two alarms an hour about one dead printer is how an owner learns to ignore both.
 *
 * And one thing that is not about a restaurant at all: a **burst of unknown serials**,
 * which is the only signal serial enumeration gives off. It rides this cron because it
 * is the same subject (printers, and whether they are who they say they are) on the
 * same five-minute beat, but it is an independent step — a database problem in one
 * restaurant's scope must not hide a sweep of the whole platform.
 *
 * The rules it shares with the stale-order alarm: **the restaurant is told first and
 * we are told at the same time** (unlike a stale order, a dead printer is often ours
 * to chase — a unit to replace, a config to fix), and **nobody is woken for a closed
 * restaurant**. A printer switched off at closing time is not a fault, and 3am is not
 * the moment to say so.
 */

/**
 * Every five minutes: the resolution, not the threshold. A printer polls every few
 * seconds, so three minutes of silence is already long past a missed beat; five
 * minutes is how often we look, and it bounds how late the news is.
 */
export const HEARTBEAT_CRON = '*/5 * * * *' as const

/** Silence that means something is wrong, against a printer that polls every few seconds. */
export const PRINTER_SILENT_MS = 3 * 60_000
/** A ticket collected and unconfirmed for this long is a ticket that did not print. */
export const STUCK_JOB_MS = 10 * 60_000
/** One alert an hour per printer. Twelve runs an hour, one text — see `printers.lastAlertAt`. */
export const ALERT_COOLDOWN_MS = 60 * 60_000
/** How far back the unknown-serial count reaches. */
export const PROBE_BURST_WINDOW_MS = 10 * 60_000
/**
 * How many **distinct** unknown serials inside that window mean somebody is sweeping.
 * A genuinely unknown serial is one mis-provisioned printer repeating itself forever,
 * so the number that matters is how many different ones there are, not how loud they
 * are.
 */
export const PROBE_BURST_THRESHOLD = 20

/** What one location's check came to. `silentMinutes` is null when only tickets are stuck. */
export type PrinterAlert = {
  locationId: string
  printerId: string
  silentMinutes: number | null
  stuckJobs: number
}

/** The unknown-serial count for this run, and whether it rang anybody's phone. */
export type ProbeBurst = { serials: number; alerted: boolean }

export type HeartbeatSummary = {
  /** Locations looked at. Every location, every five minutes — see `listLocationIds`. */
  scanned: number
  /** Only the ones that actually had something wrong *and* were open *and* were not in a cooldown. */
  alerted: PrinterAlert[]
  probeBurst: ProbeBurst
}

export const printerHeartbeat = inngest.createFunction(
  { id: 'printer-heartbeat', name: 'Printer heartbeat', triggers: { cron: HEARTBEAT_CRON } },
  ({ step }) => sweepPrinters(step),
)

/**
 * The sweep itself, one step-tool short of being an Inngest function — split out for
 * the reason CLAUDE.md gives, and because the location scan has to be mockable: the
 * shared `test` branch holds thousands of locations and a real sweep would open a
 * transaction against each.
 *
 * **Three steps, not one per location** — the same arithmetic the unsnooze cron makes,
 * only twelve times worse: a step per location here would be `locations × 12 × 24 × 30`
 * a month of almost entirely nothing.
 *
 * The two alerting legs run under `Promise.allSettled`, like the order fan-out's, and
 * for the same reason: they are independent, and one restaurant's database trouble
 * must not swallow a platform-wide security signal. The run still ends red when either
 * fails, naming which.
 */
export async function sweepPrinters(step: GetStepTools<typeof inngest>): Promise<HeartbeatSummary> {
  const locationIds = await step.run('list-locations', listLocationIds)

  const [health, burst] = await Promise.allSettled([
    step.run('alert-locations', () => alertLocations(locationIds)),
    step.run('alert-probe-burst', alertProbeBurst),
  ])

  const failures = [
    health.status === 'rejected' ? `alert-locations: ${describe(health.reason)}` : null,
    burst.status === 'rejected' ? `alert-probe-burst: ${describe(burst.reason)}` : null,
  ].filter((failure): failure is string => failure !== null)
  if (failures.length > 0) throw new Error(`printer heartbeat incomplete — ${failures.join('; ')}`)

  // Narrowing: `failures` being empty means neither leg rejected, but the compiler
  // cannot know that, so the checks are repeated rather than cast away.
  return {
    scanned: locationIds.length,
    alerted: health.status === 'fulfilled' ? health.value : [],
    probeBurst: burst.status === 'fulfilled' ? burst.value : { serials: 0, alerted: false },
  }
}

/** Every location in turn — see `alertLocation`. One restaurant's failure is not another's. */
async function alertLocations(locationIds: string[]): Promise<PrinterAlert[]> {
  const alerted: PrinterAlert[] = []
  const failures: string[] = []

  for (const locationId of locationIds) {
    try {
      const alert = await alertLocation(locationId)
      if (alert) alerted.push(alert)
    } catch (err) {
      // Caught rather than thrown on the spot: one restaurant's database trouble must
      // not leave every other restaurant's dead printer undiscovered. The run still
      // ends red, below.
      failures.push(`${locationId}: ${describe(err)}`)
    }
  }

  // Named, not counted: which restaurant went unchecked is the first thing anyone
  // needs, and "the heartbeat failed" is not an actionable sentence.
  if (failures.length > 0) throw new Error(`printer heartbeat incomplete — ${failures.join('; ')}`)
  return alerted
}

/**
 * One location: decide, ring two phones, then start the cooldown.
 *
 * **Decide inside a transaction, send outside it, stamp afterwards.** Sending from
 * inside would hold a database transaction open across two HTTP calls to Twilio, which
 * is a connection held for a network's worth of latency on every alert.
 *
 * **Send before stamping, not after**, and the asymmetry is deliberate — the same one
 * the order fan-out makes about its SMS leg. Stamping first would mean an SMS failure
 * silently buys an hour of silence about a dead printer; sending first means a retry
 * after a partial failure can text an owner twice. A duplicate alert is a nuisance; a
 * missed one is a kitchen that does not know it stopped printing.
 */
async function alertLocation(locationId: string): Promise<PrinterAlert | null> {
  const now = new Date()
  const due = await assess(locationId, now)
  if (!due) return null

  const message = heartbeatMessage(due.name, due.silentMinutes, due.stuckJobs)
  // The owner first: it is their kitchen, and most of these are fixed by walking over
  // to the printer. Ours goes to the same words on purpose — one message to get right,
  // and it names the restaurant because we have more than one of them.
  await sendSms(due.phoneE164, message)
  await sendSms(env('OPS_ALERT_E164'), message)

  await withLocation(locationId, (tx) => tx.update(printers)
    .set({ lastAlertAt: now })
    .where(inArray(printers.id, due.printerIds)))

  return {
    locationId,
    printerId: due.printerId,
    silentMinutes: due.silentMinutes,
    stuckJobs: due.stuckJobs,
  }
}

type Due = {
  printerIds: string[]
  /** The printer the alert is *about*: the silent one, or the one whose tickets stuck. */
  printerId: string
  silentMinutes: number | null
  stuckJobs: number
  name: string
  phoneE164: string
}

/**
 * Is anything wrong here, and is this the moment to say so?
 *
 * One scoped transaction, so the printer's silence, the stuck tickets and the hours
 * that decide whether to page all come from one consistent view of the database.
 *
 * The order of the four questions is the cheap-first order, and it is also the honest
 * one: most locations fail the first two and never reach the hours read.
 */
async function assess(locationId: string, now: Date): Promise<Due | null> {
  return withLocation(locationId, async (tx): Promise<Due | null> => {
    const units = await tx.select({
      id: printers.id, lastSeenAt: printers.lastSeenAt, lastAlertAt: printers.lastAlertAt,
    }).from(printers)
    // No printer, nothing to watch. A location without one is not broken — plenty of
    // them take orders on the tablet alone.
    if (units.length === 0) return null

    // **A printer that has never polled is not silent.** `lastSeenAt` is null for a
    // unit provisioned but not yet plugged in at the restaurant, and texting an owner
    // that the printer still in its box is offline is how the alarm loses its
    // credibility before the first real one.
    const silent = units.filter((unit) =>
      unit.lastSeenAt !== null && now.getTime() - unit.lastSeenAt.getTime() > PRINTER_SILENT_MS)

    // `delivered` means the bytes left us; `confirmed` means the printer says the
    // ticket came out. Counted from `created_at` because there is no `delivered_at`
    // column — which makes this "a ticket queued ten minutes ago still has not
    // printed", a slightly broader question and the one an owner would actually ask.
    const [{ stuckJobs }] = await tx.select({ stuckJobs: count() }).from(printJobs)
      .where(and(
        eq(printJobs.status, 'delivered'),
        lt(printJobs.createdAt, new Date(now.getTime() - STUCK_JOB_MS)),
      ))

    if (silent.length === 0 && stuckJobs === 0) return null

    // Read on `tx` and read *now*, not at the start of the sweep: a restaurant can
    // close between two locations of one run.
    const open = await isOpenAt(locationId, now, tx)
    if (!open.open) return null

    // **One alert an hour, and the clock is the printer's own column.** Taken across
    // the location's printers rather than per printer: the product is one printer per
    // location, so the two are the same number today, and if a second is ever added
    // the answer "one text an hour about this kitchen" is still the right one.
    const lastAlertAt = units.reduce<Date | null>(
      (latest, unit) => (unit.lastAlertAt && (!latest || unit.lastAlertAt > latest) ? unit.lastAlertAt : latest),
      null,
    )
    if (lastAlertAt && now.getTime() - lastAlertAt.getTime() < ALERT_COOLDOWN_MS) return null

    const [location] = await tx.select({ name: locations.name, phoneE164: locations.phoneE164 })
      .from(locations).where(eq(locations.id, locationId)).limit(1)
    // `locations` is the tenancy root and carries no RLS, so this is a real absence,
    // and a printer row could not exist without it. Thrown rather than skipped: it is
    // a broken invariant, not a quiet restaurant.
    if (!location) throw new Error(`printer heartbeat: location ${locationId} does not exist`)

    // The longest-silent unit is the one worth naming; with nothing silent, the alert
    // is about stuck tickets and any printer at the location is the one to name.
    const worst = silent.reduce<typeof units[number] | null>(
      (longest, unit) => (!longest || unit.lastSeenAt! < longest.lastSeenAt! ? unit : longest),
      null,
    )
    return {
      printerIds: units.map((unit) => unit.id),
      printerId: (worst ?? units[0]).id,
      // `floor`, not `round`: "has not checked in for 7 min" is true for the whole of
      // the seventh minute, and rounding up would say eight while it is still seven.
      silentMinutes: worst ? Math.floor((now.getTime() - worst.lastSeenAt!.getTime()) / 60_000) : null,
      stuckJobs,
      name: location.name,
      phoneE164: location.phoneE164,
    }
  })
}

/**
 * The one message both phones get.
 *
 * It says what is wrong and what to do about it, in that order, and it never says
 * "printer offline" on its own — an owner reading that on a Friday night needs the
 * next action in the same sentence. The em dash is not in GSM-7, so this sends as
 * UCS-2 at 70 characters a segment: the combined version is two segments, which is the
 * right trade for an alarm and the wrong one for anything sent per order.
 */
function heartbeatMessage(name: string, silentMinutes: number | null, stuckJobs: number): string {
  const faults: string[] = []
  if (silentMinutes !== null) faults.push(`the kitchen printer has not checked in for ${silentMinutes} min`)
  if (stuckJobs > 0) faults.push(`${stuckJobs} ticket${stuckJobs === 1 ? '' : 's'} may not have printed`)
  return `Serveside: at ${name}, ${faults.join(' and ')} — check the printer.`
}

/**
 * The platform-wide question: is somebody guessing printer serials at us?
 *
 * The CloudPRNT route records every well-formed serial it cannot place (see
 * `printer_probe_events` and the route's own header). One unknown serial repeating is
 * a mis-provisioned printer at an install; twenty different ones in ten minutes is a
 * sweep, and a hit on a sweep costs a real kitchen its next ticket — with the
 * customer's name and phone number on it.
 *
 * Unscoped `db()` on purpose: a row here belongs to no location, which is the whole
 * reason the table is exempt from RLS.
 *
 * Counted, never blocked. The mitigation that belongs on the poll path is the flat
 * `jobReady: false` it already answers — see the route for why rate-limiting a printer
 * behind a restaurant's NAT is the wrong tool.
 */
async function alertProbeBurst(): Promise<ProbeBurst> {
  const now = new Date()
  const since = new Date(now.getTime() - PROBE_BURST_WINDOW_MS)

  // Aggregated rather than read: during an actual sweep this window holds a row per
  // serial tried, and the only two facts wanted are how many and whether anyone has
  // been told.
  const [window] = await db()
    .select({ serials: count(), lastAlertedAt: max(printerProbeEvents.alertedAt) })
    .from(printerProbeEvents)
    .where(gt(printerProbeEvents.lastSeenAt, since))

  const serials = window?.serials ?? 0
  if (serials <= PROBE_BURST_THRESHOLD) return { serials, alerted: false }

  // One text an hour, for the same reason the printer alert has one: a sweep lasts as
  // long as the attacker likes, and a text every five minutes is a phone nobody reads.
  const lastAlertedAt = window?.lastAlertedAt ?? null
  if (lastAlertedAt && now.getTime() - lastAlertedAt.getTime() < ALERT_COOLDOWN_MS) {
    return { serials, alerted: false }
  }

  // Us only. There is no restaurant to tell: by definition these serials are nobody's.
  await sendSms(
    env('OPS_ALERT_E164'),
    `Serveside: ${serials} unknown printer serials polled in the last 10 min — possible serial sweep.`,
  )
  // Stamped after the send, like the printer alert, and on the rows that made the
  // count: they *are* the alert, so marking them is the record that it went out.
  await db().update(printerProbeEvents)
    .set({ alertedAt: now })
    .where(gt(printerProbeEvents.lastSeenAt, since))

  return { serials, alerted: true }
}

/** A failure's reason, flattened for one line of a report. */
function describe(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
