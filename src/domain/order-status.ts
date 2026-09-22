import { orderStatus } from '@/db/schema'

/** The eight states, taken from the column so the type and the enum cannot drift apart. */
export type OrderStatus = (typeof orderStatus.enumValues)[number]

/**
 * Every legal move, and nothing else:
 *
 * ```
 * PENDING_PAYMENT → NEW → ACCEPTED → IN_KITCHEN → READY → COMPLETED
 *                    ↓        ↓
 *                 REJECTED  CANCELED
 * ```
 *
 * Two edges that look like mistakes and are not:
 *
 * - **`ACCEPTED → READY` skips `IN_KITCHEN`.** A small kitchen never taps the
 *   middle button. Forcing the step would train staff to tap twice, which makes
 *   the timestamps fiction.
 * - **`CANCELED` from every non-terminal state, including `PENDING_PAYMENT`.** An
 *   abandoned checkout has to end somewhere.
 *
 * Terminal means terminal: `COMPLETED`, `REJECTED` and `CANCELED` have no way out.
 * A completed order that needs undoing is a refund (`paymentStatus`) plus an event,
 * never a walk back up the machine — the money already moved, and the ticket
 * already printed.
 */
export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  PENDING_PAYMENT: ['NEW', 'CANCELED'],
  NEW: ['ACCEPTED', 'REJECTED', 'CANCELED'],
  ACCEPTED: ['IN_KITCHEN', 'READY', 'CANCELED'],
  IN_KITCHEN: ['READY', 'CANCELED'],
  READY: ['COMPLETED', 'CANCELED'],
  COMPLETED: [],
  REJECTED: [],
  CANCELED: [],
}

/**
 * What is on the kitchen tablet: every status the kitchen still owes something on.
 *
 * It is exactly the non-terminal set **minus `PENDING_PAYMENT`** — an order still on
 * a payment form is not the kitchen's problem and must never appear on the board, or
 * a cook starts on food nobody has paid for. `src/domain/order-status.test.ts` pins
 * that derivation, so a ninth status added to the machine fails there by name rather
 * than quietly never reaching a feed.
 */
export const KITCHEN_STATUSES = ['NEW', 'ACCEPTED', 'IN_KITCHEN', 'READY'] as const

/**
 * Note what is missing: a status to itself. Two taps on "Accept" must not append a
 * second event and a second `acceptedAt`; the caller decides whether that is an
 * error or a no-op, but the machine will not call it a move.
 *
 * Fails closed on a status it does not recognise — a row written by a newer deploy
 * must not throw inside the kitchen feed's render loop. `transition` is the loud one.
 */
export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return (ORDER_TRANSITIONS[from] ?? []).includes(to)
}

/** Thrown, never returned: an illegal move is a bug or an attack, not a state. */
export class IllegalTransitionError extends Error {
  readonly from: OrderStatus
  readonly to: OrderStatus

  constructor(from: OrderStatus, to: OrderStatus) {
    super(`Illegal order transition ${from} → ${to}`)
    this.name = 'IllegalTransitionError'
    this.from = from
    this.to = to
  }
}

/** The row `transition` hands back, ready to insert once the caller adds `orderId`. */
export type NewOrderEvent = {
  type: 'status_changed'
  actor: string
  payload: { from: OrderStatus; to: OrderStatus }
}

/**
 * Moves an order, or refuses to.
 *
 * Pure — it touches no database. It returns the next status **and the event row
 * that must be appended with it**, because "every state change writes an event" is
 * only true if the two are impossible to separate: the caller writes both inside
 * one transaction (Task 7's `withLocation`), or writes neither.
 *
 * Takes any object with a `status`, so a whole order row from the feed can be
 * passed straight in. `actor` is a Clerk user id, or `system` for a webhook or cron.
 */
export function transition(
  order: { status: OrderStatus },
  to: OrderStatus,
  actor: string,
): { next: OrderStatus; event: NewOrderEvent } {
  const from = order.status
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to)
  return { next: to, event: { type: 'status_changed', actor, payload: { from, to } } }
}
