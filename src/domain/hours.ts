import { and, eq, gt, lte } from 'drizzle-orm'
import { db } from '@/db/client'
import { businessHours, holidayClosures, locations, orderPauses } from '@/db/schema'

export type ClosedReason = 'closed_hours' | 'holiday' | 'paused'
export type OpenState = { open: boolean; reason?: ClosedReason }

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
 */
export async function isOpenAt(locationId: string, at: Date): Promise<OpenState> {
  const location = await db().query.locations.findFirst({
    where: eq(locations.id, locationId),
    columns: { timezone: true },
  })
  // A caller asking about a location that does not exist has a bug. Answering
  // "closed" would hide it behind a plausible-looking result.
  if (!location) throw new Error(`Unknown location ${locationId}`)

  const [pause] = await db().select({ id: orderPauses.id }).from(orderPauses)
    .where(and(
      eq(orderPauses.locationId, locationId),
      // `until > at` alone decides it — an expired row is history, not a switch.
      gt(orderPauses.until, at),
    ))
    .limit(1)
  if (pause) return { open: false, reason: 'paused' }

  const [closure] = await db().select({ id: holidayClosures.id }).from(holidayClosures)
    .where(and(
      eq(holidayClosures.locationId, locationId),
      lte(holidayClosures.startsAt, at),
      gt(holidayClosures.endsAt, at),
    ))
    .limit(1)
  if (closure) return { open: false, reason: 'holiday' }

  const local = localWallClock(at, location.timezone)
  const [service] = await db().select({ id: businessHours.id }).from(businessHours)
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
  // `hourCycle: 'h23'`, never `hour12: false` — that pairing makes some ICU
  // builds render local midnight as hour "24", which would read as past close.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at)

  const part = (type: Intl.DateTimeFormatPartTypes): string => {
    const found = parts.find((p) => p.type === type)
    if (!found) throw new Error(`Intl gave no ${type} for timezone ${timeZone}`)
    return found.value
  }

  const dow = DOW_BY_WEEKDAY[part('weekday')]
  if (dow === undefined) throw new Error(`Unrecognised weekday ${part('weekday')} for timezone ${timeZone}`)
  return { dow, time: `${part('hour')}:${part('minute')}:${part('second')}` }
}
