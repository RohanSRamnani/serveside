import { eq } from 'drizzle-orm'
import { locations, orders, orderEvents, orderStatus } from '@/db/schema'
import { withLocation, isUuid, type ScopedTx } from '@/repo/scoped'
import { ordersRepo } from '@/repo/orders-repo'
import {
  transition, IllegalTransitionError, KITCHEN_STATUSES,
  type OrderStatus, type NewOrderEvent,
} from '@/domain/order-status'
import { toFeedOrder, type FeedOrder } from '@/domain/feed'
import { requireLocationAccess, deniedResponse } from '@/lib/authz'

/**
 * Every button on the kitchen tablet — Accept, Ready, Complete, Reject — is this one
 * route, and it is the only way an order's status ever moves by hand.
 *
 * It decides nothing about which moves are legal. `transition()` owns the machine and
 * hands back both the next status **and the event row to append with it**; this route
 * writes the two inside one `withLocation` transaction, which is the whole of "every
 * state change writes an event" — separable, they would not both survive a crash.
 *
 * The location is named on the query string (`?location=<slug>`) rather than derived
 * from the order, and that is not a convenience: an order id alone cannot be read at
 * all, because `orders` is under RLS and the scope has to be chosen before the first
 * SELECT. Naming it lets the session be authorized against a location **before** any
 * scope opens, and an order in a different location of the same group then simply is
 * not found — RLS filters rather than raising.
 *
 *   400  body is not JSON, or no `location`
 *   401  no session
 *   403  a session whose active org does not own that location
 *   404  no such order in that location
 *   422  `invalid_input` (a status the machine has no name for, a nonsense bump),
 *        `not_on_the_board` (an order the kitchen does not own) or
 *        `illegal_transition` (a move the machine refuses), the latter naming both ends
 *   200  `{ order }` — the whole card, re-read, so the tablet can replace it outright
 *
 * TODO(plan-2/refunds): rejecting or canceling a PAID order moves no money — the
 * customer stays charged until the dashboard refund flow exists (spec §4). Owner must
 * refund in Stripe manually until then.
 */

/** The eight names the column may hold, as a runtime set — the request body is untrusted text. */
const STATUSES = new Set<string>(orderStatus.enumValues)

/**
 * The largest prep bump a button may ask for. The tablet offers +5/+10/+15; this is
 * the outer bound on a hand-typed one, and it exists so a fat finger cannot promise a
 * customer a pickup time tomorrow. A genuine two-hour wait is a phone call, not a bump.
 */
const MAX_PREP_BUMP_MINUTES = 120

type Body = { to: OrderStatus; prepBumpMinutes?: number; reason?: string }

type Outcome =
  | { kind: 'moved'; order: FeedOrder }
  | { kind: 'not_found' }
  | { kind: 'not_on_the_board'; from: OrderStatus }
  | { kind: 'illegal'; from: OrderStatus; to: OrderStatus }

export async function POST(req: Request, ctx: RouteContext<'/api/orders/[id]/transition'>): Promise<Response> {
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

  const { id } = await ctx.params
  // Shape-checked before it reaches a query: a malformed uuid raises 22P02, which
  // inside a transaction poisons every statement after it. Not a 400 — a string that
  // is not an id names no order, and "no such order" is the honest answer.
  if (!isUuid(id)) return Response.json({ error: 'order_not_found' }, { status: 404 })

  const at = new Date()
  let outcome: Outcome
  try {
    outcome = await withLocation(access.location.id, async (tx): Promise<Outcome> => {
      // Locked for the rest of the transaction, and matched on `location_id` as well
      // as `id` — the scope is already open, so the predicate is the belt to RLS's
      // braces. It is not decoration: RLS is silently inert for a role that owns the
      // tables, and this repo has shipped with `.env.local` pointing at the Neon
      // owner. An order from another location comes back undefined, which is a 404.
      const order = await ordersRepo(tx).lockById(access.location.id, id)
      if (!order) return { kind: 'not_found' }

      // **This route may only move what is on the board**, and the excluded status
      // that matters is `PENDING_PAYMENT`. The machine allows `PENDING_PAYMENT → NEW`
      // because the Stripe webhook needs it — but that flip is three facts at once
      // (status, `paymentStatus = 'PAID'`, a quoted time from the moment the money
      // landed), and only the webhook knows all three. Done from here it would put an
      // unpaid order in the kitchen *and* leave it NEW + REQUIRES_PAYMENT, which no
      // longer matches the webhook's own fingerprint — so when the card finally did
      // pay, the flip would be declined as "nothing to do" and the order would never
      // be marked paid at all. No tablet button can reach this; a stale tab or a
      // hand-rolled request can.
      if (!(KITCHEN_STATUSES as readonly OrderStatus[]).includes(order.status)) {
        return { kind: 'not_on_the_board', from: order.status }
      }

      let move: { next: OrderStatus; event: NewOrderEvent }
      try {
        move = transition(order, body.to, access.userId)
      } catch (err) {
        // The machine's refusal, carried out to HTTP unchanged. Nothing has been
        // written, so there is nothing to undo.
        if (err instanceof IllegalTransitionError) return { kind: 'illegal', from: err.from, to: err.to }
        throw err
      }

      const stamps = await stampsFor(move.next, at, body, () => prepTime(tx, access.location.id))
      await tx.update(orders).set({ ...stamps, status: move.next }).where(eq(orders.id, order.id))
      await tx.insert(orderEvents).values({ orderId: order.id, ...move.event })

      // Re-read rather than patching the row we already have: the card the tablet
      // renders is then the row that is actually in the database, and the lines come
      // back with it so a card can be replaced whole instead of merged.
      const moved = await ordersRepo(tx).getWithItems(order.id)
      if (!moved) throw new Error(`Order ${order.id} vanished inside its own transaction`)
      return { kind: 'moved', order: toFeedOrder(moved) }
    })
  } catch (err) {
    console.error('[POST /api/orders/:id/transition] failed for order', id, err)
    return Response.json({ error: 'server_error' }, { status: 500 })
  }

  if (outcome.kind === 'not_found') return Response.json({ error: 'order_not_found' }, { status: 404 })
  if (outcome.kind === 'not_on_the_board') {
    return Response.json({
      error: 'not_on_the_board',
      from: outcome.from,
      message: `An order that is ${outcome.from} is not the kitchen’s to move.`,
    }, { status: 422 })
  }
  if (outcome.kind === 'illegal') {
    return Response.json({
      error: 'illegal_transition',
      from: outcome.from,
      to: outcome.to,
      message: `An order that is ${outcome.from} cannot become ${outcome.to}.`,
    }, { status: 422 })
  }
  return Response.json({ order: outcome.order })
}

/** The parsed body, or the sentence explaining why it is not one. */
function parseBody(raw: unknown): Body | string {
  if (typeof raw !== 'object' || raw === null) return 'Body must be a JSON object.'
  const b = raw as Record<string, unknown>

  if (typeof b.to !== 'string' || !STATUSES.has(b.to)) {
    return `\`to\` must be one of ${orderStatus.enumValues.join(', ')}.`
  }
  const body: Body = { to: b.to as OrderStatus }

  // Present-but-null is refused along with the rest: that is what a client-side `NaN`
  // or `undefined` variable arrives as once `JSON.stringify` has been over it, and a
  // NaN here would store an Invalid Date as somebody's promised pickup time.
  if (b.prepBumpMinutes !== undefined) {
    const bump = b.prepBumpMinutes
    if (typeof bump !== 'number' || !Number.isInteger(bump) || bump < 0 || bump > MAX_PREP_BUMP_MINUTES) {
      return `\`prepBumpMinutes\` must be a whole number of minutes between 0 and ${MAX_PREP_BUMP_MINUTES}.`
    }
    body.prepBumpMinutes = bump
  }

  if (b.reason !== undefined) {
    if (typeof b.reason !== 'string' || b.reason.length > 500) return '`reason` must be a short string.'
    body.reason = b.reason
  }
  return body
}

/**
 * The prep time read **inside the transaction that makes the promise**, not the copy
 * the authorization check happened to load a moment earlier — the same rule the
 * Stripe webhook follows. `locations` is not under RLS, so a scoped transaction may
 * read it directly.
 */
async function prepTime(tx: ScopedTx, locationId: string): Promise<number> {
  const [row] = await tx.select({ prepTimeMinutes: locations.prepTimeMinutes })
    .from(locations).where(eq(locations.id, locationId)).limit(1)
  if (!row) throw new Error(`Unknown location ${locationId}`)
  return row.prepTimeMinutes
}

/**
 * The columns that go with a move, beyond `status` itself.
 *
 * **`IN_KITCHEN` and `REJECTED` have no timestamp of their own**, and that is the
 * schema's decision, not an omission here: the `order_events` row carries the moment
 * for every move, and only the four milestones a receipt or a dispute quotes get a
 * column. Do not invent `rejectedAt` in an UPDATE; add the column and a migration.
 *
 * `readPrepTime` is a thunk rather than a number so the extra round trip happens on
 * an accept and on nothing else — three of the four tablet buttons do not need it.
 */
async function stampsFor(
  next: OrderStatus,
  at: Date,
  body: Body,
  readPrepTime: () => Promise<number>,
): Promise<Partial<typeof orders.$inferInsert>> {
  switch (next) {
    case 'ACCEPTED':
      return {
        acceptedAt: at,
        // The promise the customer is given, and the clock starts on acceptance — not
        // on checkout, and not on whatever the order was quoted before it was bumped.
        quotedReadyAt: new Date(at.getTime() + ((await readPrepTime()) + (body.prepBumpMinutes ?? 0)) * 60_000),
      }
    case 'READY': return { readyAt: at }
    case 'COMPLETED': return { completedAt: at }
    // TODO(plan-2/refunds): rejecting or canceling a PAID order moves no money — the
    // customer stays charged until the dashboard refund flow exists (spec §4). Owner
    // must refund in Stripe manually until then.
    case 'CANCELED': return { canceledAt: at, cancelReason: body.reason ?? null }
    // REJECTED lands here: no column of its own, and — see the TODO above — no money
    // moves either. A rejected card order is a charge the customer still has.
    default: return {}
  }
}
