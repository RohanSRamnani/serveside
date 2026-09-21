import { asc, eq, gte } from 'drizzle-orm'
import { orders, orderItems, orderItemModifiers } from '@/db/schema'
import type { Order, NewOrder } from '@/db/schema'
import type { ScopedTx } from './scoped'

/** One line of a new order, with its chosen modifiers. Ids are filled in by `insertOrder`. */
export type NewOrderLine = Omit<typeof orderItems.$inferInsert, 'id' | 'orderId'> & {
  modifiers?: Omit<typeof orderItemModifiers.$inferInsert, 'orderItemId'>[]
}

/**
 * Reads and writes for one location's orders.
 *
 * Every method here is **deliberately missing a `location_id` filter**, and that
 * is not an oversight: the transaction is already scoped, and RLS adds the
 * predicate. Writing the filter twice would hide the day RLS stops working.
 *
 * Note what the reads do NOT do: join `order_items.menu_item_id` back to the live
 * menu. The names and prices on the line are the record — see `orders.ts`.
 */
export function ordersRepo(tx: ScopedTx) {
  return {
    /**
     * Orders placed at or after `sinceIso`, oldest first — the shape a kitchen feed
     * polls with. Ties break on id so a caller paging on `createdAt` cannot skip a
     * row when two land in the same millisecond.
     */
    async listSince(sinceIso: string): Promise<Order[]> {
      return tx.select().from(orders)
        .where(gte(orders.createdAt, new Date(sinceIso)))
        .orderBy(asc(orders.createdAt), asc(orders.id))
    },

    /**
     * One order, or `undefined`. An id belonging to another location reads as
     * "not found" rather than "forbidden" — RLS filters, it does not raise, and
     * a 404 leaks less than a 403 anyway.
     */
    async getById(id: string): Promise<Order | undefined> {
      const [row] = await tx.select().from(orders).where(eq(orders.id, id)).limit(1)
      return row
    },

    /**
     * Writes the order and its lines in one go — same transaction, so a half-written
     * order with no items cannot reach a kitchen printer.
     *
     * Does not append an `order_events` row: what the event says depends on how the
     * order was created (web checkout, voice, cash at the counter), so the caller
     * that knows appends it. `orders.location_id` must match the scope or the
     * WITH CHECK refuses the insert.
     */
    async insertOrder(values: NewOrder, lines: NewOrderLine[] = []): Promise<Order> {
      const [order] = await tx.insert(orders).values(values).returning()
      for (const { modifiers, ...line } of lines) {
        const [item] = await tx.insert(orderItems).values({ ...line, orderId: order.id }).returning()
        if (modifiers?.length) {
          await tx.insert(orderItemModifiers).values(modifiers.map((m) => ({ ...m, orderItemId: item.id })))
        }
      }
      return order
    },

    /** The lines of one order. `order_items` has no sort column, so id is the stable order. */
    async itemsFor(orderId: string) {
      return tx.select().from(orderItems).where(eq(orderItems.orderId, orderId)).orderBy(asc(orderItems.id))
    },
  }
}

export type OrdersRepo = ReturnType<typeof ordersRepo>
