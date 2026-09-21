import { withLocation } from '@/repo/scoped'
import { ordersRepo, type OrderWithLines } from '@/repo/orders-repo'
import type { Order } from '@/db/schema'
import type { OrderStatus } from './order-status'

/**
 * What a kitchen tablet is handed, and deliberately not the order row.
 *
 * A projection rather than `select *` for two reasons. The obvious one: the row
 * carries things a tablet on a counter has no business rendering or holding in
 * browser memory — `stripePaymentIntentId`, `menuSnapshotId`, the money breakdown
 * nobody reads off a ticket. The load-bearing one: this is the wire format, so it is
 * written down once and the server component, the polling client and the transition
 * response all agree on it. Timestamps are ISO strings here rather than `Date`s
 * because that is what survives `Response.json` and what the client actually gets —
 * typing them as `Date` would be a lie the compiler believed.
 */
export type FeedModifier = {
  nameSnapshot: string
  priceDeltaCents: number
}

export type FeedItem = {
  id: string
  nameSnapshot: string
  qty: number
  /** The customer's note on this line ("extra crispy") — cooked from, so never dropped. */
  notes: string | null
  modifiers: FeedModifier[]
}

export type FeedOrder = {
  id: string
  shortCode: string
  status: OrderStatus
  fulfillment: Order['fulfillment']
  paymentStatus: Order['paymentStatus']
  channel: Order['channel']
  contactName: string
  contactPhone: string
  /** The customer's note to the kitchen, about the whole order. */
  notes: string | null
  totalCents: number
  createdAt: string
  quotedReadyAt: string | null
  scheduledFor: string | null
  items: FeedItem[]
}

export type FeedPayload = {
  orders: FeedOrder[]
  /**
   * The **server's** clock at the moment the feed was read, and the reason every
   * elapsed time on the tablet is computed against it rather than `Date.now()`: a
   * kitchen tablet's clock is whatever it was when someone last plugged it in, and
   * "8 minutes late" computed from a device that is four minutes out is a customer
   * being told the wrong thing.
   */
  now: string
}

/** The row → wire mapping, shared so a transition response and a poll cannot drift. */
export function toFeedOrder(order: OrderWithLines): FeedOrder {
  return {
    id: order.id,
    shortCode: order.shortCode,
    status: order.status,
    fulfillment: order.fulfillment,
    paymentStatus: order.paymentStatus,
    channel: order.channel,
    contactName: order.contactName,
    contactPhone: order.contactPhone,
    notes: order.notes,
    totalCents: order.totalCents,
    createdAt: order.createdAt.toISOString(),
    quotedReadyAt: order.quotedReadyAt?.toISOString() ?? null,
    scheduledFor: order.scheduledFor?.toISOString() ?? null,
    items: order.items.map((item) => ({
      id: item.id,
      nameSnapshot: item.nameSnapshot,
      qty: item.qty,
      notes: item.notes,
      modifiers: item.modifiers.map((m) => ({
        nameSnapshot: m.nameSnapshot,
        priceDeltaCents: m.priceDeltaCents,
      })),
    })),
  }
}

/**
 * One read of the board, scoped to one location.
 *
 * Shared by the API route the tablet polls and the page that renders its first
 * paint, so a kitchen never sees the feed change shape between load and first poll.
 * Takes a location **id** and not a slug: authorization has already happened by the
 * time anything calls this — see `src/lib/authz.ts`.
 */
export async function readFeed(locationId: string, sinceIso?: string): Promise<FeedPayload> {
  // The location id goes in twice on purpose: once to open the RLS scope, once into
  // the query's own WHERE clause. See the note at the top of `orders-repo.ts` — this
  // is the read a browser renders, and it must not depend on a policy being live.
  const orders = await withLocation(locationId, (tx) =>
    ordersRepo(tx).listActiveWithItems(locationId, sinceIso))
  return { orders: orders.map(toFeedOrder), now: new Date().toISOString() }
}
