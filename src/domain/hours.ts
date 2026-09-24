import { and, asc, eq, gt, lte } from 'drizzle-orm'
import { db } from '@/db/client'
import { businessHours, holidayClosures, locations, orderPauses } from '@/db/schema'
import { withLocation, type ScopedTx } from '@/repo/scoped'

export type ClosedReason = 'closed_hours' | 'holiday' | 'paused'
export type OpenState = { open: boolean; reason?: ClosedReason }

/**
 * One row of the weekly grid, as wall-clock strings (`HH:MM:SS`) in the location's
 * own timezone — never an instant. `closeTime` may legitimately be `24:00:00`.
 */
export type ServiceWindow = { openTime: string; closeTime: string }

/** `Intl` weekday short names → `business_hours.dow` (0 = Sunday). */
const DOW_BY_WEEKDAY: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
}

/**
 * Can this location take an order at this instant?
 *
 * **Precedence — paused, then holiday, then closed_hours.** The most specific,
 * most recent human decision wins: a kitchen that just hit "we're slammed" is
 * paused even on a day it never posted hours for, and a dated closure outranks
 * the weekly grid. The reason is what the customer is told and what the voice
 * agent says, so "paused" must never be reported as "closed_hours" — one is
 * "try again in an hour", the other is "come back Tuesday".
 *
 * Everything is evaluated in `locations.timezone`. The server's own clock zone
 * is never consulted: `at` is an instant, and the weekly grid is wall-clock
 * local time, so the only correct bridge between them is the location's zone.
 *
 * All three hours tables are under RLS as of `drizzle/0009_...`, so the reads run
 * scoped. Pass a `tx` to answer inside a caller's transaction — Task 8's checkout
 * wants "are you open" and "write the order" to see one consistent database.
 * Without one it opens its own scope, so the original two-argument call still works.
 *
 * `locations` itself is not under RLS and is read through `db()`: there is nothing
 * to scope to until we know the location exists.
 */
export async function isOpenAt(locationId: string, at: Date, tx?: ScopedTx): Promise<OpenState> {
  const location = await db().query.locations.findFirst({
    where: eq(locations.id, locationId),
    columns: { timezone: true },
  })
  // A caller asking about a location that does not exist has a bug. Answering
  // "closed" would hide it behind a plausible-looking result.
  if (!location) throw new Error(`Unknown location ${locationId}`)

  const local = localWallClock(at, location.timezone)
  if (!tx) return withLocation(locationId, (scoped) => readState(scoped, locationId, at, local))
  return readState(tx, locationId, at, local)
}

/**
 * The hours posted for the day it currently is **at the restaurant** — what a
 * customer reads off a door, and the storefront header's one honest answer to
 * "well, when are you open then?".
 *
 * Several rows is the normal case, not the exception: split service is two rows and
 * `business_hours` is deliberately not unique on `(location_id, dow)`. They come back
 * in opening order so lunch is printed before dinner.
 *
 * Deliberately **not** folded into `isOpenAt`. That answers a yes/no question the
 * order path gates on, and it must stay the cheapest read in the codebase — three
 * `limit(1)`s — whereas this is copy for one page and is wanted even when the answer
 * is "closed". It also cannot be derived from `OpenState`: a paused or holiday-closed
 * restaurant still has hours posted for today, which is exactly what makes "try again
 * in an hour" and "come back tomorrow" different sentences.
 *
 * A row that says 17:00–24:00 belongs to today; the 00:00–02:00 half of the same
 * shift is tomorrow's row, and is today's first window. That is the no-midnight-wrap
 * convention, not a quirk to correct for here.
 */
export async function todayServiceWindows(
  locationId: string,
  at: Date,
  tx?: ScopedTx,
): Promise<ServiceWindow[]> {
  const location = await db().query.locations.findFirst({
    where: eq(locations.id, locationId),
    columns: { timezone: true },
  })
  if (!location) throw new Error(`Unknown location ${locationId}`)

  const { dow } = localWallClock(at, location.timezone)
  const read = (scoped: ScopedTx) => scoped
    .select({ openTime: businessHours.openTime, closeTime: businessHours.closeTime })
    .from(businessHours)
    // The `location_id` predicate is written out for the reason `storefrontView`
    // gives: this is a read a browser renders, and it must not depend on a policy
    // being live.
    .where(and(eq(businessHours.locationId, locationId), eq(businessHours.dow, dow)))
    .orderBy(asc(businessHours.openTime))

  if (!tx) return withLocation(locationId, read)
  return read(tx)
}

/**
 * The three scoped reads, in precedence order. The `location_id` predicates are
 * kept even though RLS already supplies them: this function is the one place the
 * scope and the argument could disagree, and a row from the wrong location is a
 * restaurant told it is closed when it is open.
 */
async function readState(
  tx: ScopedTx,
  locationId: string,
  at: Date,
  local: { dow: number; time: string },
): Promise<OpenState> {
  const [pause] = await tx.select({ id: orderPauses.id }).from(orderPauses)
    .where(and(
      eq(orderPauses.locationId, locationId),
      // `until > at` alone decides it — an expired row is history, not a switch.
      gt(orderPauses.until, at),
    ))
    .limit(1)
  if (pause) return { open: false, reason: 'paused' }

  const [closure] = await tx.select({ id: holidayClosures.id }).from(holidayClosures)
    .where(and(
      eq(holidayClosures.locationId, locationId),
      lte(holidayClosures.startsAt, at),
      gt(holidayClosures.endsAt, at),
    ))
    .limit(1)
  if (closure) return { open: false, reason: 'holiday' }

  const [service] = await tx.select({ id: businessHours.id }).from(businessHours)
    .where(and(
      eq(businessHours.locationId, locationId),
      eq(businessHours.dow, local.dow),
      // Compared as Postgres `time`, not as text: both sides are HH:MM:SS, and
      // `close_time` may legitimately be 24:00:00 for a shift that runs to midnight.
      lte(businessHours.openTime, local.time),
      gt(businessHours.closeTime, local.time),
    ))
    .limit(1)

  return service ? { open: true } : { open: false, reason: 'closed_hours' }
}

/** The instant as the wall clock reads it at the location: day of week + HH:MM:SS. */
function localWallClock(at: Date, timeZone: string): { dow: number; time: string } {
  const local = localParts(at, timeZone)
  const dow = DOW_BY_WEEKDAY[local.weekday]
  if (dow === undefined) throw new Error(`Unrecognised weekday ${local.weekday} for timezone ${timeZone}`)
  return { dow, time: `${local.hh}:${local.mm}:${local.ss}` }
}

/**
 * The next instant at which the clock **at the location** reads `hour:00:00` —
 * strictly after `at`, and never more than about a day and a bit away.
 *
 * This is what "86 until tomorrow" means. The two wrong answers it exists to rule out
 * are both plausible-looking arithmetic: `at + 24h` puts a dish 86'd at 9pm back at
 * 9pm tomorrow, a whole service late, and "local midnight + 6h" is an hour out on the
 * two days a year the clocks move — in March it would put the dish back at 5am and in
 * November at 7am, which is the middle of prep either way.
 *
 * So the wall clock is read through `Intl` in the location's zone, the calendar day is
 * chosen there, and the instant is recovered by correcting for the offset actually in
 * force **at that instant** rather than the one in force now. Two passes settle it:
 * the first guess is at most one DST shift out, which cannot carry it across a second
 * transition.
 *
 * A wall-clock time that does not exist (a zone that springs forward across `hour`
 * itself — no US zone does, they all move at 2am) resolves to the instant just after
 * the gap, which is the next moment that hour could be said to have arrived.
 */
export function nextLocalHour(at: Date, timeZone: string, hour: number): Date {
  const local = localParts(at, timeZone)
  // Today if the hour is still to come, tomorrow otherwise — and tomorrow when it is
  // exactly now, because an unsnooze that is already due is a 86 that never happened.
  const midnight = Date.UTC(local.year, local.month - 1, local.day)
  const day = new Date(local.hour < hour ? midnight : midnight + DAY_MS)

  const next = instantOfLocalHour(day, hour, timeZone)
  // The belt to that braces: whatever the zone does, the answer is in the future or
  // it is not an answer. One day is the largest correction any zone can need.
  if (next.getTime() > at.getTime()) return next
  return instantOfLocalHour(new Date(day.getTime() + DAY_MS), hour, timeZone)
}

/**
 * The instant the restaurant's **own day** started — midnight on the calendar day
 * `at` falls on, read in the location's timezone.
 *
 * This is what "today" means anywhere a per-day rule is counted, and it has to be the
 * restaurant's day rather than UTC's: a New York kitchen's day rolls at 8pm UTC, which
 * is the middle of dinner service. A cap that reset there would hand somebody a fresh
 * allowance on the busiest two hours of the night.
 *
 * Built on the same two pieces `nextLocalHour` uses — the wall clock through `Intl`,
 * then the offset in force *at the instant being recovered* — so it is right across a
 * DST boundary, where a local day is 23 or 25 hours long. In a zone whose clocks
 * spring forward across midnight itself (no US zone does), local midnight does not
 * exist and this resolves to the first instant after the gap, which is the earliest
 * moment that day can be said to have begun.
 */
export function startOfLocalDay(at: Date, timeZone: string): Date {
  const local = localParts(at, timeZone)
  // The calendar day held as a UTC date, which is the shape `instantOfLocalHour` reads.
  const day = new Date(Date.UTC(local.year, local.month - 1, local.day))
  return instantOfLocalHour(day, 0, timeZone)
}

const DAY_MS = 24 * 60 * 60_000

/** The instant at which `timeZone`'s clock reads this (UTC-held) calendar day at `hour:00:00`. */
function instantOfLocalHour(day: Date, hour: number, timeZone: string): Date {
  const wallAsUtc = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour)
  const guess = wallAsUtc - zoneOffsetMs(new Date(wallAsUtc), timeZone)
  return new Date(wallAsUtc - zoneOffsetMs(new Date(guess), timeZone))
}

/**
 * How far the zone's clock runs ahead of UTC at this instant, in milliseconds — read
 * from `Intl` rather than from a table, so it is right for every zone and every rule
 * change the runtime knows about. Negative west of Greenwich, and not always a whole
 * number of hours (Asia/Kolkata is +5:30, Australia/Eucla +8:45).
 */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const p = localParts(at, timeZone)
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  // `Intl` resolves to the second, so the instant is compared at the same resolution;
  // otherwise a sub-second `at` would show up as a few hundred milliseconds of offset.
  return wallAsUtc - Math.floor(at.getTime() / 1000) * 1000
}

/** One `Intl` read of an instant as the location's clock shows it, numbers and strings both. */
function localParts(at: Date, timeZone: string) {
  // `hourCycle: 'h23'`, never `hour12: false` — that pairing makes some ICU
  // builds render local midnight as hour "24", which would read as past close.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at)

  const part = (type: Intl.DateTimeFormatPartTypes): string => {
    const found = parts.find((p) => p.type === type)
    if (!found) throw new Error(`Intl gave no ${type} for timezone ${timeZone}`)
    return found.value
  }

  return {
    weekday: part('weekday'),
    year: Number(part('year')),
    month: Number(part('month')),
    day: Number(part('day')),
    hour: Number(part('hour')),
    minute: Number(part('minute')),
    second: Number(part('second')),
    hh: part('hour'),
    mm: part('minute'),
    ss: part('second'),
  }
}
