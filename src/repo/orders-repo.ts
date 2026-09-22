import { and, asc, desc, eq, gte, inArray } from 'drizzle-orm'
import { orders, orderItems, orderItemModifiers } from '@/db/schema'
import type { Order, OrderItem, OrderItemModifier, NewOrder } from '@/db/schema'
import { KITCHEN_STATUSES } from '@/domain/order-status'
import type { ScopedTx } from './scoped'

/**
 * One order with everything printed on its ticket: the lines, and the modifiers
 * chosen on each. Structural on purpose — `renderTicket`'s `OrderWithItems` is this
 * plus the location's timezone, so a column added to either side stops compiling
 * rather than quietly vanishing off a ticket.
 */
export type OrderLineWithModifiers = OrderItem & { modifiers: OrderItemModifier[] }
export type OrderWithLines = Order & { items: OrderLineWithModifiers[] }

/** One line of a new order, with its chosen modifiers. Ids are filled in by `insertOrder`. */
export type NewOrderLine = Omit<typeof orderItems.$inferInsert, 'id' | 'orderId'> & {
  modifiers?: Omit<typeof orderItemModifiers.$inferInsert, 'orderItemId'>[]
}

/**
 * Reads and writes for one location's orders.
 *
 * Most methods here carry **no `location_id` filter**, and that is not an oversight:
 * the transaction is already scoped and RLS adds the predicate, so writing it twice
 * everywhere would hide the day RLS stops working.
 *
 * **The two methods that take a `locationId` are the deliberate exception**, and the
 * reason is a real failure mode rather than a hypothetical: RLS is silently inert for
 * any role that owns the tables or has BYPASSRLS, and this repo has already shipped
 * with `.env.local` pointing `DATABASE_URL` at the Neon owner. `withLocation` refuses
 * to open a scope for such a role — but only once it has been asked to, and only for
 * the paths that go through it. The two reads that answer *"whose orders are these"*
 * to a browser — the kitchen board and the row a transition locks — say it in SQL as
 * well, so a misconfigured connection is a query that returns nothing rather than a
 * tablet showing another restaurant's dinner service.
 *
 * That makes them testable without RLS, too: scope a transaction to location B, pass
 * location A's id, and a correct predicate returns nothing where RLS alone would
 * happily hand back B's rows. `src/repo/repos.test.ts` does exactly that, which is
 * what pins the predicate rather than the policy.
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
     * The kitchen board: every order the kitchen still owes something on, newest
     * first, with its lines and the modifiers on each.
     *
     * **Three queries, not one per order.** A tablet polls this every five seconds
     * for as long as the restaurant is open, so `getWithItems` in a loop would be
     * 1 + 2N round trips on a five-second timer; this is 3 whatever N is.
     *
     * Newest first because a tablet shows the top of the list and the order that
     * just landed is the one nobody has looked at yet — the reverse of
     * {@link listSince}, which pages forward through history.
     *
     * `sinceIso` is a **floor, not a cursor**: it bounds how far back the board
     * reaches (today's service, not last month's abandoned NEW order). A caller that
     * advances it between polls would stop seeing the orders it already has, which is
     * exactly the set whose status keeps changing.
     *
     * `locationId` is required and is written into the WHERE clause on top of RLS —
     * see the note at the top of this file. This is the query whose output a browser
     * renders, so it is the one that must not depend on a policy being live.
     */
    async listActiveWithItems(locationId: string, sinceIso?: string): Promise<OrderWithLines[]> {
      const rows = await tx.select().from(orders)
        .where(and(
          eq(orders.locationId, locationId),
          inArray(orders.status, [...KITCHEN_STATUSES]),
          sinceIso ? gte(orders.createdAt, new Date(sinceIso)) : undefined,
        ))
        .orderBy(desc(orders.createdAt), desc(orders.id))
      if (rows.length === 0) return []

      const lines = await tx.select().from(orderItems)
        .where(inArray(orderItems.orderId, rows.map((o) => o.id)))
        .orderBy(asc(orderItems.nameSnapshot), asc(orderItems.id))
      const mods = lines.length === 0 ? [] : await tx.select().from(orderItemModifiers)
        .where(inArray(orderItemModifiers.orderItemId, lines.map((l) => l.id)))
        .orderBy(asc(orderItemModifiers.nameSnapshot), asc(orderItemModifiers.modifierOptionId))

      return rows.map((order) => ({
        ...order,
        items: lines.filter((l) => l.orderId === order.id)
          .map((line) => ({ ...line, modifiers: mods.filter((m) => m.orderItemId === line.id) })),
      }))
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
     * One order, locked for the rest of the transaction, and only if it really is
     * this location's.
     *
     * `FOR UPDATE` because the caller is about to move it: two tablets in one kitchen
     * tapping Accept on the same card must not both read NEW and both append a
     * `status_changed` event.
     *
     * `locationId` is required and explicit for the same reason as
     * {@link listActiveWithItems} — this is the row a browser is about to change, so
     * "is it yours" is asserted in SQL and not only by a policy. An order belonging
     * to another location comes back `undefined`, which a route turns into a 404.
     */
    async lockById(locationId: string, id: string): Promise<Order | undefined> {
      const [row] = await tx.select().from(orders)
        .where(and(eq(orders.id, id), eq(orders.locationId, locationId)))
        .for('update')
        .limit(1)
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

    /**
     * The whole order, ready to print: the row, its lines, and the modifiers on each.
     * What the Inngest fan-out hands `renderTicket`, and the only read in here that
     * is allowed to be three round trips — a ticket is printed once per order.
     *
     * **Ordered by name, not by id, and that is a compromise worth naming.**
     * `order_items` carries neither a sort column nor a `created_at`, so the order
     * the customer built their cart in is not recoverable from the database at all.
     * Falling back on `id` would mean `gen_random_uuid()` decides what order a
     * kitchen reads the dishes in, and shuffles it on a reprint. Alphabetical is at
     * least the same every time and groups a repeated dish together. Give
     * `order_items` a `sort` column and this should follow the cart.
     */
    async getWithItems(orderId: string): Promise<OrderWithLines | undefined> {
      const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).limit(1)
      if (!order) return undefined

      const lines = await tx.select().from(orderItems)
        .where(eq(orderItems.orderId, orderId))
        .orderBy(asc(orderItems.nameSnapshot), asc(orderItems.id))
      if (lines.length === 0) return { ...order, items: [] }

      const mods = await tx.select().from(orderItemModifiers)
        .where(inArray(orderItemModifiers.orderItemId, lines.map((l) => l.id)))
        .orderBy(asc(orderItemModifiers.nameSnapshot), asc(orderItemModifiers.modifierOptionId))

      return {
        ...order,
        items: lines.map((line) => ({
          ...line,
          modifiers: mods.filter((m) => m.orderItemId === line.id),
        })),
      }
    },
  }
}

export type OrdersRepo = ReturnType<typeof ordersRepo>
