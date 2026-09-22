import { requireLocationAccess, deniedResponse } from '@/lib/authz'
import { readFeed } from '@/domain/feed'

/**
 * The kitchen board. One tablet, one restaurant, polled every five seconds for as
 * long as the doors are open — see `docs/superpowers/plans/2026-09-20-ordering-spine.md`:
 * polling, not websockets, because a tablet that sleeps, drops wifi and wakes up
 * behind a NAT reconnects a poll for free and loses a socket silently.
 *
 * `?since=<iso>` **bounds** the board; it is not a cursor to advance. Every poll
 * returns the whole active set inside the window, because the interesting change
 * between two polls is usually an order that is already on the tablet moving to
 * ACCEPTED or READY — narrowing to "created since the last poll" would return an
 * empty array all afternoon and freeze the board on its first paint. Absent, the
 * window is unbounded: an order still sitting at NEW from last night was never dealt
 * with, and hiding it is not the same as it not existing.
 *
 *   400  no `location`, or a `since` that is not a date
 *   401  no session
 *   403  a session whose active org does not own that location — or no active org
 *   200  `{ orders, now }`
 */
export async function GET(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams

  // Authorization first and everything else second: a 400 that a stranger can tell
  // apart from a 403 is a way to find out which slugs are real. The one exception is
  // a missing `location`, which is answered above by `requireLocationAccess` itself —
  // there is no location to be told anything about.
  const access = await requireLocationAccess(params.get('location'))
  if (!access.ok) return deniedResponse(access)

  const since = params.get('since')
  if (since !== null && Number.isNaN(Date.parse(since))) {
    return Response.json(
      { error: 'invalid_input', message: '`since` must be an ISO 8601 instant.' },
      { status: 400 },
    )
  }

  try {
    return Response.json(await readFeed(access.location.id, since ?? undefined))
  } catch (err) {
    // Opaque: the body of a 500 is the one place a connection string, a table name or
    // another tenant's id leaks to whoever asked.
    console.error('[GET /api/feed] failed for location', access.location.id, err)
    return Response.json({ error: 'server_error' }, { status: 500 })
  }
}
