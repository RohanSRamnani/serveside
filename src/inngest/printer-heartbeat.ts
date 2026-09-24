import type { GetStepTools } from 'inngest'
import { and, count, eq, gt, inArray, lt } from 'drizzle-orm'
import { locations, printers, printJobs } from '@/db/schema'
import { withLocation } from '@/repo/scoped'
import { isOpenAt } from '@/domain/hours'
import {
  markProbesAlerted, probeWindow, pruneProbes,
  PROBE_BURST_THRESHOLD, PROBE_RETENTION_MS,
} from '@/domain/printer-probes'
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

/**
 * …and one older than this is not news any more. **The alarm has to be able to stop.**
 *
 * A job that failed to print stays at `delivered` forever — the route refuses to
 * requeue it, deliberately, because a jammed printer would otherwise fail the same
 * ticket for the rest of the night. Nothing else moves it either: `confirmed` only ever
 * comes from a printer saying it printed. So an unbounded "older than ten minutes"
 * count is a row that matches **for the life of the database**, and one jammed ticket
 * on a Tuesday would text the owner and ops every open hour, forever — which is the
 * muted-alarm failure this file's own header warns about, delivered by the file itself.
 *
 * Six hours is one service. Inside it the ticket is still worth chasing: the order may
 * be on a board, the customer may still be coming. Past it the moment has gone — the
 * kitchen closed, the order was served off the tablet or refunded, and a text about it
 * is archaeology rather than an alarm. A printer that is *still* broken keeps producing
 * fresh stuck tickets, which keep entering the window, so a genuinely ongoing fault
 * keeps alerting on its own merits rather than on the strength of one old row.
 */
export const STUCK_JOB_MAX_AGE_MS = 6 * 60 * 60_000

/** One alert an hour per printer. Twelve runs an hour, one text — see `printers.lastAlertAt`. */
export const ALERT_COOLDOWN_MS = 60 * 60_000

/** What one location's check came to. `silentMinutes` is null when only tickets are stuck. */
export type PrinterAlert = {
  locationId: string
  printerId: string
  silentMinutes: number | null
  stuckJobs: number
}

/**
 * The unknown-serial count for this run, whether it rang anybody's phone, and how many
 * aged-out rows were swept. `serials` is a **floor, not a measurement**: the route
 * stops recording new serials once the window is over threshold, so a sweep of a
 * million MACs and a sweep of twenty-one both read as twenty-one.
 */
export type ProbeBurst = { serials: number; alerted: boolean; pruned: number }

/**
 * Everything one pass over the locations found, **including everything that went
 * wrong**. The step returns this rather than throwing, and the reason is the whole of
 * the design note on {@link alertLocations}: what is thrown out of a step is lost the
 * moment a retry of that step succeeds, and some of this can never be rediscovered.
 */
type LocationSweep = {
  alerted: PrinterAlert[]
  /**
   * Locations whose alarm was not raised at all — unreadable, or both phones refused.
   * Nothing was stamped for these, so the next tick five minutes from now tries again
   * on its own. Reported so the run is red, not so anybody has to act.
   */
  unraised: string[]
  /**
   * Alerts that reached one of the two phones and not the other. **The cooldown is
   * stamped for these**, so this report is the only record that will ever exist: the
   * next tick finds them quiet and has nothing to say.
   */
  undelivered: string[]
}

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
 *
 * TODO(scale): one transaction per location every five minutes — twelve times the
 * unsnooze cron's load and against the same unavoidable full scan (`listLocationIds`
 * explains why there is no narrower question to ask under RLS). Two indexed reads
 * each, so it is fine into the low hundreds and wrong in the thousands, where it would
 * also outrun a serverless invocation. The fix is the same one named there: a second
 * SECURITY DEFINER function — returning only the locations with a silent printer or a
 * stuck ticket — which has to be argued for by name in `src/repo/rls.test.ts` first.
 */
export async function sweepPrinters(step: GetStepTools<typeof inngest>): Promise<HeartbeatSummary> {
  const locationIds = await step.run('list-locations', listLocationIds)

  const [health, burst] = await Promise.allSettled([
    step.run('alert-locations', () => alertLocations(locationIds)),
    step.run('alert-probe-burst', alertProbeBurst),
  ])

  // **Everything that went wrong in the sweep fails the RUN from here, not the step.**
  // A step-level failure is retried, and a retry of this step cannot rediscover what
  // the first attempt found: the alerts that went out stamped their cooldown, so the
  // retry sees quiet restaurants, contributes nothing, and comes back green — a
  // permanently broken `OPS_ALERT_E164` would vanish into a successful run and we would
  // never learn our own alarm has no way to reach us. Thrown out here instead, the step
  // stays memoized (nothing is re-sent) and every attempt re-reads the same accounting
  // and ends red with the restaurant and the phone named. That is the same mechanism
  // the order fan-out uses, and `src/inngest/order-created.ts` sets out why the body's
  // throw re-runs the body only.
  const failures = [
    health.status === 'rejected' ? `alert-locations: ${describe(health.reason)}` : null,
    burst.status === 'rejected' ? `alert-probe-burst: ${describe(burst.reason)}` : null,
    health.status === 'fulfilled' && health.value.unraised.length > 0
      ? `alarms not raised — ${health.value.unraised.join('; ')}`
      : null,
    health.status === 'fulfilled' && health.value.undelivered.length > 0
      ? `alerts reached only one phone — ${health.value.undelivered.join('; ')}`
      : null,
  ].filter((failure): failure is string => failure !== null)
  if (failures.length > 0) throw new Error(`printer heartbeat incomplete — ${failures.join('; ')}`)

  // Narrowing: `failures` being empty means neither leg rejected, but the compiler
  // cannot know that, so the checks are repeated rather than cast away.
  return {
    scanned: locationIds.length,
    alerted: health.status === 'fulfilled' ? health.value.alerted : [],
    probeBurst: burst.status === 'fulfilled' ? burst.value : { serials: 0, alerted: false, pruned: 0 },
  }
}

/**
 * Every location in turn — see `alertLocation`. One restaurant's failure is not
 * another's, so each is caught where it happens.
 *
 * **This function never throws, and that is the load-bearing part.** Everything it
 * learns comes back in {@link LocationSweep} and `sweepPrinters` fails the run from the
 * function body. The obvious alternative — throw when anything went wrong, and let the
 * step retry — loses information it can never get back, on a platform where alerts are
 * wrong together rather than one at a time:
 *
 *   `OPS_ALERT_E164` is **one number for the whole platform**, so a broken one fails
 *   the ops leg at *every* alerting location in the same tick. Say restaurant A's own
 *   number also refuses (it replied STOP) and restaurant B's alert therefore reached
 *   the owner but not ops. Throwing would report A and discard B. The step retries; B
 *   is inside the cooldown it stamped on the first attempt, so it is not looked at
 *   again and cannot be rediscovered; A's failure clears; the step resolves clean and
 *   the run goes **green** — with a broken ops number at every restaurant on the
 *   platform and nothing anywhere saying so.
 *
 * So nothing is discarded. The two kinds of bad news are kept apart only because they
 * mean different things to whoever reads the run, not because they are treated
 * differently here: `unraised` will fix itself on the next tick, `undelivered` never
 * will.
 *
 * What is lost by not throwing is the step's own retry for a transient failure — and
 * this is a cron, so the next tick five minutes later *is* that retry, and unlike the
 * step's it cannot quietly bury anything. `unraised` locations stamp nothing, which is
 * exactly what makes that work.
 */
async function alertLocations(locationIds: string[]): Promise<LocationSweep> {
  const alerted: PrinterAlert[] = []
  const unraised: string[] = []
  const undelivered: string[] = []

  for (const locationId of locationIds) {
    try {
      const result = await alertLocation(locationId)
      if (!result) continue
      alerted.push(result.alert)
      // Named, not counted, all the way up: which restaurant, and which phone, is the
      // first thing anyone needs. "The heartbeat failed" is not an actionable sentence.
      undelivered.push(...result.undelivered.map((failure) => `${locationId}: ${failure}`))
    } catch (err) {
      unraised.push(`${locationId}: ${describe(err)}`)
    }
  }

  return { alerted, unraised, undelivered }
}

/**
 * One location: decide, ring two phones, then start the cooldown.
 *
 * **Decide inside a transaction, send outside it, stamp afterwards.** Sending from
 * inside would hold a database transaction open across two HTTP calls to Twilio, which
 * is a connection held for a network's worth of latency on every alert.
 *
 * **Both texts go out together and the cooldown starts if either of them landed.** The
 * two phones are one alert, and the question the stamp answers is "has this alarm been
 * raised", not "did every leg of it succeed":
 *
 * - Both failed — Twilio is down — so nothing was raised: no stamp, and the **throw**
 *   makes the step retry and genuinely try again.
 * - One failed: somebody knows. Stamping is what stops the retry texting the other one
 *   a second, third and fourth time about one dead printer, and retrying would not fix
 *   the usual cause anyway (a restaurant phone that has replied STOP, or an
 *   `OPS_ALERT_E164` nobody set). So this **returns rather than throws**, and the
 *   failure is carried up to `sweepPrinters`, which fails the run outside the step —
 *   where a retry cannot quietly turn it green.
 *
 * Stamping *before* sending would be the worst of both: an SMS failure would silently
 * buy an hour of silence about a kitchen that has stopped printing.
 */
async function alertLocation(
  locationId: string,
): Promise<{ alert: PrinterAlert; undelivered: string[] } | null> {
  const now = new Date()
  const due = await assess(locationId, now)
  if (!due) return null

  // One message to both, on purpose: it is one thing to get right, and it names the
  // restaurant because we have more than one of them. Concurrently, because the
  // restaurant-first ordering that matters is the stale-order escalation's four
  // minutes, not two milliseconds here — a dead printer is often ours to chase.
  const message = heartbeatMessage(due.name, due.silentMinutes, due.stuckJobs)
  const [owner, ops] = await Promise.allSettled([
    sendSms(due.phoneE164, message),
    textOps(message),
  ])

  // Named, because which phone did not ring decides what someone does next: a bad
  // restaurant number is a support call, and a bad one of ours is a deploy.
  const failures = [
    owner.status === 'rejected' ? `owner: ${describe(owner.reason)}` : null,
    ops.status === 'rejected' ? `ops: ${describe(ops.reason)}` : null,
  ].filter((failure): failure is string => failure !== null)

  if (failures.length === 2) {
    // Nothing was raised, so the hour must not start here: throw, and let the step's
    // retry try the whole thing again.
    throw new Error(`could not raise the printer alert — ${failures.join('; ')}`)
  }

  await withLocation(locationId, (tx) => tx.update(printers)
    .set({ lastAlertAt: now })
    .where(inArray(printers.id, due.printerIds)))

  return {
    alert: {
      locationId,
      printerId: due.printerId,
      silentMinutes: due.silentMinutes,
      stuckJobs: due.stuckJobs,
    },
    undelivered: failures,
  }
}

/**
 * Our own phone. A function rather than an inline `env()` call so that a missing
 * `OPS_ALERT_E164` is a **rejected promise** inside `Promise.allSettled` rather than a
 * synchronous throw that escapes it — which would leave the owner's text in flight,
 * unawaited, and lose the very message that matters most.
 */
async function textOps(message: string): Promise<void> {
  await sendSms(env('OPS_ALERT_E164'), message)
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
    //
    // **Bounded at both ends**, and the upper bound is not tidiness: nothing ever moves
    // a job off `delivered`, so an open-ended predicate matches the same row forever
    // and one jammed ticket would text this restaurant every open hour for the life of
    // the database. See {@link STUCK_JOB_MAX_AGE_MS}.
    //
    // Served by `print_jobs_delivered_idx` — partial on `delivered`, leading on
    // `location_id` because RLS adds that equality to every statement. Without it this
    // is a sequential scan of every ticket the restaurant has ever printed, per
    // location, twelve times an hour, forever; the partial index holds only the
    // handful of jobs actually in flight, exactly as the queued one does.
    const [{ stuckJobs }] = await tx.select({ stuckJobs: count() }).from(printJobs)
      .where(and(
        eq(printJobs.status, 'delivered'),
        lt(printJobs.createdAt, new Date(now.getTime() - STUCK_JOB_MS)),
        gt(printJobs.createdAt, new Date(now.getTime() - STUCK_JOB_MAX_AGE_MS)),
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

    const [location] = await tx
      .select({ name: locations.name, phoneE164: locations.phoneE164, synthetic: locations.synthetic })
      .from(locations).where(eq(locations.id, locationId)).limit(1)
    // `locations` is the tenancy root and carries no RLS, so this is a real absence,
    // and a printer row could not exist without it. Thrown rather than skipped: it is
    // a broken invariant, not a quiet restaurant.
    if (!location) throw new Error(`printer heartbeat: location ${locationId} does not exist`)
    // **A synthetic location (the canary) is never alerted about**, owner or ops. It has
    // no printer today, so the "no printer" return above already covers it — this is
    // the check on the flag itself, so a printer row added to it by mistake still rings
    // nobody. No stamp either: nothing was raised.
    if (location.synthetic) return null

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

  // **Retention first, and on this cron rather than anywhere else.** The table is a
  // durable write a stranger triggers, so "nothing prunes it" was never an acceptable
  // answer — it just deferred the cleanup to a migration somebody would have to write
  // during an incident. Here it is a rolling 24-hour window that maintains itself on
  // the same five-minute beat as the alarm that reads it. It cannot affect the count
  // below: everything it removes is a day older than the ten-minute window.
  const pruned = await pruneProbes(new Date(now.getTime() - PROBE_RETENTION_MS))

  const { serials, lastAlertedAt } = await probeWindow(now)
  if (serials <= PROBE_BURST_THRESHOLD) return { serials, alerted: false, pruned }

  // One text an hour, for the same reason the printer alert has one: a sweep lasts as
  // long as the attacker likes, and a text every five minutes is a phone nobody reads.
  if (lastAlertedAt && now.getTime() - lastAlertedAt.getTime() < ALERT_COOLDOWN_MS) {
    return { serials, alerted: false, pruned }
  }

  // Us only. There is no restaurant to tell: by definition these serials are nobody's.
  //
  // "At least", because the number really is a floor: the route stops recording new
  // serials once the window is over threshold, so this reads twenty-one whether
  // twenty-one MACs were tried or ten million. Claiming an exact count would be
  // claiming we measured something we deliberately stopped measuring.
  await textOps(
    `Serveside: at least ${serials} unknown printer serials polled in the last 10 min`
    + ' — possible serial sweep.',
  )
  // Stamped after the send, like the printer alert, and on the rows that made the
  // count: they *are* the alert, so marking them is the record that it went out.
  await markProbesAlerted(now)

  return { serials, alerted: true, pruned }
}

/** A failure's reason, flattened for one line of a report. */
function describe(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
