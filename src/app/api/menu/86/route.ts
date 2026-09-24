import { buildMenuSnapshot } from '@/domain/snapshot'
import { nextLocalHour } from '@/domain/hours'
import { requireLocationAccess, deniedResponse } from '@/lib/authz'
import { menuRepo, type EightySixTarget, type EightySixed } from '@/repo/menu-repo'
import { withLocation, isUuid, type ScopedTx } from '@/repo/scoped'
import { reportError } from '@/lib/report'

/**
 * The 86 button — two taps, "until tomorrow", and it puts itself back.
 *
 * It is the highest-frequency action in the product: a kitchen runs out of something
 * most services, and the only version of this that gets used is one that costs nothing
 * to undo. Hence `until: 'tomorrow'`, which sets a deadline the hourly job
 * (`src/inngest/unsnooze.ts`) clears on its own, and `until: 'manual'` for the dish
 * that is off for the season.
 *
 *   POST   `{ itemId | modifierOptionId, until: 'tomorrow' | 'manual' }` → sold out
 *   DELETE `{ itemId | modifierOptionId }`                              → back on sale
 *
 * **Both rebuild the location's menu snapshot inside the same transaction as the
 * toggle**, which is the controller's standing ruling for every menu mutation, and it
 * is not bookkeeping. Orders pin the *current* snapshot rather than building one each
 * (`getOrBuildCurrentSnapshot`), so a 86 that did not rebuild would leave every later
 * order pinning evidence that says the dish was on sale. `createOrder` reads live rows,
 * so the money stays right either way — but the pinned payload is what settles a
 * dispute six months from now, and it has to agree.
 *
 * Same transaction, not two: a dish flagged sold-out against a snapshot that never
 * moved is precisely the split state the rule exists to forbid, and a crash between
 * two transactions would produce it.
 *
 *   400  no `location`, or a body that is not JSON
 *   401  no session
 *   403  a session whose active org does not own that location
 *   404  no such dish or topping **on this location's menu** — including another
 *        restaurant's, which RLS hides rather than refusing
 *   409  the location does not have exactly one active menu, so nothing can be pinned
 *   422  a body that names no target, both targets, or a snooze we cannot read
 *   200  `{ target, is86d, unsnoozeAt, snapshot: { id, version } }`
 */

/** "Until tomorrow" is 6am at the restaurant: after the night shift, before prep. */
const UNSNOOZE_HOUR = 6

type Until = 'tomorrow' | 'manual'
type Body = { target: EightySixTarget; until: Until }

type Outcome =
  | { kind: 'done'; row: EightySixed; snapshot: { id: string; version: number } }
  | { kind: 'not_found' }

/**
 * Thrown rather than returned, because **a return commits**: `withLocation` rolls
 * back on a throw and on nothing else. This refusal arrives after the toggle has
 * already been written, so returning it would leave the dish flagged sold-out against
 * a snapshot that never moved — the exact split state the same-transaction rule
 * exists to forbid.
 */
class MenuUnavailable extends Error {
  constructor(readonly activeMenuCount: number) {
    super(`Location has ${activeMenuCount} active menus; exactly one can be pinned`)
    this.name = 'MenuUnavailable'
  }
}

export async function POST(req: Request): Promise<Response> {
  return handle(req, 'sold-out')
}

export async function DELETE(req: Request): Promise<Response> {
  return handle(req, 'back-on-sale')
}

/** One handler for both verbs: they differ by two fields on one UPDATE, and by nothing else. */
async function handle(req: Request, direction: 'sold-out' | 'back-on-sale'): Promise<Response> {
  const sold = direction === 'sold-out'

  // Authorization first, and before any scope opens: `withLocation` will faithfully
  // open whichever location it is handed, for whoever asked.
  const access = await requireLocationAccess(new URL(req.url).searchParams.get('location'))
  if (!access.ok) return deniedResponse(access)

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  // `until` is read on the way in on a POST and ignored on a DELETE, which puts the
  // dish back with no deadline at all.
  const body = parseBody(raw, sold)
  if (typeof body === 'string') {
    return Response.json({ error: 'invalid_input', message: body }, { status: 422 })
  }

  let outcome: Outcome
  try {
    // The deadline is read from the location's own timezone — the copy the
    // authorization check already loaded — and never from the server's clock zone.
    // Inside the `try` because a location carrying a timezone `Intl` does not
    // recognise would throw here, and that is our data problem, not an unhandled one.
    const unsnoozeAt = sold && body.until === 'tomorrow'
      ? nextLocalHour(new Date(), access.location.timezone, UNSNOOZE_HOUR)
      : null
    outcome = await withLocation(access.location.id, (tx) => toggle(tx, access.location.id, body.target, sold, unsnoozeAt))
  } catch (err) {
    if (err instanceof MenuUnavailable) {
      // 409 rather than 500: the owner can fix this, and the sentence says how.
      // Nothing was written — the toggle rolled back with the rebuild it could not do.
      return Response.json({
        error: 'menu_unavailable',
        activeMenuCount: err.activeMenuCount,
        message: err.activeMenuCount === 0
          ? 'This location has no active menu, so there is nothing to take off it.'
          : `This location has ${err.activeMenuCount} active menus; exactly one must be active.`,
      }, { status: 409 })
    }
    // Opaque: the body of a 500 is the one place a table name or another tenant's id
    // leaks to whoever asked.
    reportError('[/api/menu/86] failed for location', access.location.id, err)
    return Response.json({ error: 'server_error' }, { status: 500 })
  }

  if (outcome.kind === 'not_found') {
    return Response.json({
      error: 'not_found',
      message: body.target.kind === 'item'
        ? 'No such dish on this location’s menu.'
        : 'No such option on this location’s menu.',
    }, { status: 404 })
  }

  return Response.json({
    target: body.target,
    is86d: outcome.row.is86d,
    // Echoed from the row rather than from the input: what the database holds is what
    // the hourly job will act on.
    unsnoozeAt: outcome.row.unsnoozeAt?.toISOString() ?? null,
    snapshot: outcome.snapshot,
  })
}

/**
 * The toggle and the rebuild, in one transaction.
 *
 * **The write goes first and the menu check second**, which reads backwards and is
 * not: returning `menu_unavailable` after the UPDATE means the refusal is a
 * *rollback*, and a rollback is the only observable difference between "one
 * transaction" and "two things that usually both happen". Checked beforehand, a
 * version of this route that committed the toggle and rebuilt separately would pass
 * every test here. It also keeps "no such dish" answerable as 404 for a location whose
 * menu happens to be in a state that cannot be pinned.
 *
 * The check exists at all because `buildMenuSnapshot` answers both "no active menu"
 * and "two active menus" with a plain `Error`, which on a route a person is tapping
 * would be an opaque 500 for a state they can see and fix.
 */
async function toggle(
  tx: ScopedTx,
  locationId: string,
  target: EightySixTarget,
  sold: boolean,
  unsnoozeAt: Date | null,
): Promise<Outcome> {
  const repo = menuRepo(tx)

  const row = sold ? await repo.set86(target, unsnoozeAt) : await repo.clear86(target)
  // RLS filters rather than raising, so another restaurant's dish simply matches no
  // row. Returning here is what stops a miss rebuilding a snapshot for a menu that
  // did not change.
  if (!row) return { kind: 'not_found' }

  const activeMenus = await repo.activeMenuIds()
  if (activeMenus.length !== 1) throw new MenuUnavailable(activeMenus.length)

  return { kind: 'done', row, snapshot: await buildMenuSnapshot(locationId, tx) }
}

/** The parsed body, or the sentence explaining why it is not one. */
function parseBody(raw: unknown, sold: boolean): Body | string {
  if (typeof raw !== 'object' || raw === null) return 'Body must be a JSON object.'
  const b = raw as Record<string, unknown>

  const named = (['itemId', 'modifierOptionId'] as const).filter((key) => b[key] !== undefined)
  if (named.length === 0) return 'Name the dish as `itemId` or the option as `modifierOptionId`.'
  // Not "prefer the item": two ids could mean either, and picking one silently 86s
  // something the kitchen did not ask about while telling them it worked.
  if (named.length === 2) return 'Name `itemId` or `modifierOptionId`, not both.'

  const key = named[0]
  const id = b[key]
  // Shape-checked before it reaches a query: a malformed uuid raises 22P02, which
  // inside a transaction poisons every statement after it.
  if (typeof id !== 'string' || !isUuid(id)) return `\`${key}\` must be a uuid.`
  const target: EightySixTarget = key === 'itemId' ? { kind: 'item', id } : { kind: 'option', id }

  // A DELETE puts it back unconditionally; there is no deadline to read.
  if (!sold) return { target, until: 'manual' }

  if (b.until !== 'tomorrow' && b.until !== 'manual') {
    return '`until` must be `tomorrow` (back at 6am, local) or `manual`.'
  }
  return { target, until: b.until }
}
