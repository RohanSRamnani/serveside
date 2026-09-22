import { and, eq, gt } from 'drizzle-orm'
import { orderPauses } from '@/db/schema'
import { requireLocationAccess, deniedResponse } from '@/lib/authz'
import { withLocation } from '@/repo/scoped'

/**
 * "We're slammed — stop taking orders." One tap, with a length on it.
 *
 *   POST   `{ minutes, reason? }` → a pause that expires on its own
 *   DELETE                        → resume now, because the rush cleared early
 *
 * The switch itself lives in `isOpenAt`, which reports **paused ahead of holiday
 * ahead of closed_hours**: a kitchen that just hit this is paused even on a day it
 * never posted hours for. `createOrder` asks `isOpenAt` inside the transaction that
 * writes the order, so a pause takes effect on the next checkout, not the next deploy
 * — and the customer is told "try again in an hour" rather than "come back Tuesday".
 *
 * **A pause expires by itself.** `until` is what ends it, so a row left behind can
 * never keep a location dark, and no job has to remember to lift it. That is also why
 * there is no delete here: resuming early shortens the live rows instead, which keeps
 * the reason, the moment and the person who paused — how often a kitchen has to stop
 * taking orders is worth knowing, and it is the first number an owner asks about when
 * the ordering line goes quiet.
 *
 *   400  no `location`, or a body that is not JSON
 *   401  no session
 *   403  a session whose active org does not own that location
 *   422  a length that is not a real stretch of minutes
 *   200  `{ paused: true, until, reason }` / `{ paused: false, resumed }`
 */

/**
 * Twelve hours would cover any rush; a day is the outer bound on a fat finger. Longer
 * than this is not "we're slammed", it is a closure — `holiday_closures`, which the
 * customer is told about differently and which survives a pause being lifted.
 */
const MAX_PAUSE_MINUTES = 24 * 60

export async function POST(req: Request): Promise<Response> {
  const access = await requireLocationAccess(new URL(req.url).searchParams.get('location'))
  if (!access.ok) return deniedResponse(access)

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const body = parseBody(raw)
  if (typeof body === 'string') {
    return Response.json({ error: 'invalid_input', message: body }, { status: 422 })
  }

  const until = new Date(Date.now() + body.minutes * 60_000)
  try {
    await withLocation(access.location.id, (tx) => tx.insert(orderPauses).values({
      locationId: access.location.id,
      until,
      reason: body.reason,
      // The Clerk user id, as on every other staff action. Null in this column means
      // the system paused the location, which is a different fact from a person doing
      // it and must stay tellable apart.
      createdBy: access.userId,
    }))
  } catch (err) {
    console.error('[POST /api/pause] failed for location', access.location.id, err)
    return Response.json({ error: 'server_error' }, { status: 500 })
  }

  return Response.json({ paused: true, until: until.toISOString(), reason: body.reason })
}

/**
 * Resume now: every pause still in force is shortened to this instant.
 *
 * Every one, not the newest — two taps in a rush is two rows, and a resume that
 * lifted only the last would leave an earlier one holding the doors shut with nothing
 * on screen to say so. The rows stay, with their reasons: this is a resume, not an
 * erasure.
 */
export async function DELETE(req: Request): Promise<Response> {
  const access = await requireLocationAccess(new URL(req.url).searchParams.get('location'))
  if (!access.ok) return deniedResponse(access)

  const at = new Date()
  try {
    const resumed = await withLocation(access.location.id, (tx) => tx.update(orderPauses)
      .set({ until: at })
      // One instant for the predicate and the value, so a row cannot be "ended" at a
      // moment that is still in the future. `isOpenAt` treats `until` as exclusive.
      .where(and(eq(orderPauses.locationId, access.location.id), gt(orderPauses.until, at)))
      .returning({ id: orderPauses.id }))
    return Response.json({ paused: false, resumed: resumed.length })
  } catch (err) {
    console.error('[DELETE /api/pause] failed for location', access.location.id, err)
    return Response.json({ error: 'server_error' }, { status: 500 })
  }
}

type Body = { minutes: number; reason: string | null }

/** The parsed body, or the sentence explaining why it is not one. */
function parseBody(raw: unknown): Body | string {
  if (typeof raw !== 'object' || raw === null) return 'Body must be a JSON object.'
  const b = raw as Record<string, unknown>

  // Integer-checked rather than coerced: `Number('30')` would accept a form post that
  // never went through the tablet, and a NaN would store an Invalid Date as the
  // moment the restaurant reopens — which reads as "never" to `isOpenAt`.
  const minutes = b.minutes
  if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > MAX_PAUSE_MINUTES) {
    return `\`minutes\` must be a whole number between 1 and ${MAX_PAUSE_MINUTES}.`
  }

  if (b.reason === undefined || b.reason === null) return { minutes, reason: null }
  if (typeof b.reason !== 'string' || b.reason.length > 500) return '`reason` must be a short string.'
  // Blank is stored as no reason at all: a kitchen mid-rush will not type one, and an
  // empty string in the column would read as a reason that was given and lost.
  return { minutes, reason: b.reason.trim() === '' ? null : b.reason }
}
