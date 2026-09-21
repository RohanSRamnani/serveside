import { pgTable, pgEnum, uuid, text, integer, bigint, jsonb, timestamp, primaryKey, check, foreignKey } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { locations } from './tenancy'
import { menuItems, modifierOptions } from './menu'
import { menuSnapshots } from './snapshots'

/**
 * The order lifecycle. The machine that says which of these may follow which is
 * `src/domain/order-status.ts`; this is only the set of names a column may hold.
 *
 * `PENDING_PAYMENT` is where a card order starts — it is not yet the kitchen's
 * problem. A pay-at-pickup order (voice, or cash at the counter) skips it and
 * enters at `NEW` with `paymentStatus = 'PAY_ON_PICKUP'`.
 */
export const orderStatus = pgEnum('order_status', [
  'PENDING_PAYMENT', 'NEW', 'ACCEPTED', 'IN_KITCHEN', 'READY', 'COMPLETED', 'REJECTED', 'CANCELED',
])

/**
 * Money state, tracked apart from the kitchen state on purpose: a COMPLETED order
 * can later become REFUNDED, and a CANCELED one may or may not have been paid.
 * Collapsing the two into one column is how refunds go missing.
 */
export const paymentStatus = pgEnum('payment_status', [
  'REQUIRES_PAYMENT', 'PAID', 'PAY_ON_PICKUP', 'REFUNDED',
])

/** How the order reached us. Voice and SMS are later products; the column exists from day one. */
export const orderChannel = pgEnum('order_channel', ['web', 'voice', 'sms'])

export const fulfillment = pgEnum('fulfillment', ['pickup', 'delivery'])

/**
 * An order. A money record and a legal one: it is the evidence in a card dispute
 * and the thing a customer is read back over the phone.
 *
 * Three rules hold this table up, and none of them may be relaxed later:
 *
 * 1. **Every money column is `bigint` cents.** No floats anywhere near a total.
 * 2. **`menuSnapshotId` is NOT NULL.** Every order pins the exact menu it was
 *    quoted from, so "you charged me $18 for a $16 dish" is answerable six months
 *    on. There is no such thing as an order without a snapshot.
 * 3. **It scopes to `locationId`, not `orgId`** — one missing WHERE clause must
 *    not hand another restaurant's orders out.
 */
export const orders = pgTable('orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  /**
   * The 4-character code on the ticket and the confirmation screen — see
   * `src/lib/short-code.ts`. Human shorthand at one counter on one day, never an
   * identifier: it is deliberately **not** unique, and nothing may look an order
   * up by short code alone.
   */
  shortCode: text('short_code').notNull(),
  channel: orderChannel('channel').notNull(),
  fulfillment: fulfillment('fulfillment').notNull(),
  /** No default: a row that never said what it was is a bug, not a PENDING_PAYMENT order. */
  status: orderStatus('status').notNull(),
  paymentStatus: paymentStatus('payment_status').notNull(),
  /**
   * Nullable and deliberately unreferenced: `customers` lands with retention
   * (Plan 3). Contact details live inline on the order until then, so nothing in
   * this plan needs the table to exist. Add the FK when it does.
   */
  customerId: uuid('customer_id'),
  /** Phone is required, not optional: it is how a kitchen chases a no-show pickup. */
  contactName: text('contact_name').notNull(),
  contactPhone: text('contact_phone').notNull(),
  contactEmail: text('contact_email'),
  /** Null = ASAP. Set only for an order placed for later. */
  scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
  /** What the customer was promised, from `locations.prepTimeMinutes` — kept so a late order is provable. */
  quotedReadyAt: timestamp('quoted_ready_at', { withTimezone: true }),
  subtotalCents: bigint('subtotal_cents', { mode: 'number' }).notNull(),
  taxCents: bigint('tax_cents', { mode: 'number' }).notNull(),
  tipCents: bigint('tip_cents', { mode: 'number' }).notNull().default(0),
  deliveryFeeCents: bigint('delivery_fee_cents', { mode: 'number' }).notNull().default(0),
  /** Stored positive and **subtracted** from the total. A discount is never a negative number here. */
  discountCents: bigint('discount_cents', { mode: 'number' }).notNull().default(0),
  /** What was actually charged. No default — a total must be computed, never assumed. */
  totalCents: bigint('total_cents', { mode: 'number' }).notNull(),
  /**
   * Null until a card order gets an intent, and forever on a pay-at-pickup order.
   * Unique: two orders sharing one PaymentIntent means one payment was counted twice.
   * (Postgres lets a unique column hold many NULLs, so the cash orders are fine.)
   */
  stripePaymentIntentId: text('stripe_payment_intent_id').unique(),
  /**
   * NOT NULL, no exceptions — see rule 2 above. The FK is composite and declared
   * below, not here: it carries `location_id` with it.
   */
  menuSnapshotId: uuid('menu_snapshot_id').notNull(),
  /** Customer's note to the kitchen ("no cilantro"). Not an internal field. */
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  readyAt: timestamp('ready_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  canceledAt: timestamp('canceled_at', { withTimezone: true }),
  cancelReason: text('cancel_reason'),
}, (t) => [
  /**
   * **Composite on purpose.** `(location_id, menu_snapshot_id)` must name a snapshot
   * of *this* location, not any snapshot anywhere — a plain FK to `menu_snapshots.id`
   * would let one restaurant's order pin another's menu, and since the snapshot is
   * the price evidence in a dispute, that is a tenancy leak wearing a receipt.
   *
   * RLS does not cover this: both rows are legal inside their own tenant, and
   * referential-integrity checks bypass row security anyway. Only the constraint does.
   */
  foreignKey({
    name: 'orders_snapshot_location_fk',
    columns: [t.locationId, t.menuSnapshotId],
    foreignColumns: [menuSnapshots.locationId, menuSnapshots.id],
  }),
  // Cents, so every one of these is a whole number of pennies; none of them may be
  // negative. A refund is `paymentStatus = 'REFUNDED'`, never a negative total, and a
  // discount is a positive number that gets subtracted.
  check('orders_money_non_negative', sql`
    ${t.subtotalCents} >= 0 AND ${t.taxCents} >= 0 AND ${t.tipCents} >= 0
    AND ${t.deliveryFeeCents} >= 0 AND ${t.discountCents} >= 0 AND ${t.totalCents} >= 0
  `),
])

/**
 * One line of the order, with the menu item's name and price **copied in**.
 *
 * `nameSnapshot` and `unitPriceCents` are not conveniences — they are the record.
 * Nothing may render, print or total a historical order by joining `menuItemId`
 * back to the live menu: the dish gets renamed, repriced and 86'd, and the order
 * from last March must still say what was bought and for how much.
 *
 * `menuItemId` stays as an FK anyway, for reporting ("how many butter chickens
 * this quarter") and so a typo'd id fails loudly. Keeping it means the menu editor
 * must retire an item with `isActive = false` rather than deleting it, which is
 * already how the menu works.
 */
export const orderItems = pgTable('order_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id').notNull().references(() => orders.id),
  menuItemId: uuid('menu_item_id').notNull().references(() => menuItems.id),
  nameSnapshot: text('name_snapshot').notNull(),
  qty: integer('qty').notNull(),
  /** The item's price **plus its modifier deltas**, per unit; `lineTotalCents = unitPriceCents * qty`. */
  unitPriceCents: bigint('unit_price_cents', { mode: 'number' }).notNull(),
  lineTotalCents: bigint('line_total_cents', { mode: 'number' }).notNull(),
  notes: text('notes'),
}, (t) => [
  // A zero or negative quantity is not an order line, it is a bug that reaches a
  // printed ticket and a charge.
  check('order_items_qty_positive', sql`${t.qty} > 0`),
  check('order_items_money_non_negative', sql`${t.unitPriceCents} >= 0 AND ${t.lineTotalCents} >= 0`),
])

/**
 * The modifiers chosen on one line — "Hot", "+ Extra Paneer" — again with the name
 * and the price delta copied in.
 *
 * `priceDeltaCents` has **no default**: an implicit 0 would let a copy that forgot
 * the delta look like a legitimately free choice. Deltas may be negative (a size
 * down), which is why this is the one money column here without a `>= 0` check.
 *
 * Keyed on `(orderItemId, modifierOptionId)`, so one option cannot be recorded
 * twice against one line — a retried insert cannot silently double a charge. The
 * flip side, named so nobody discovers it in production: **"extra shot ×2" is not
 * representable.** Repeat-quantity modifiers would need a `qty` column here, which
 * the spec does not have.
 */
export const orderItemModifiers = pgTable('order_item_modifiers', {
  orderItemId: uuid('order_item_id').notNull().references(() => orderItems.id),
  modifierOptionId: uuid('modifier_option_id').notNull().references(() => modifierOptions.id),
  nameSnapshot: text('name_snapshot').notNull(),
  priceDeltaCents: bigint('price_delta_cents', { mode: 'number' }).notNull(),
}, (t) => [primaryKey({ columns: [t.orderItemId, t.modifierOptionId] })])

/** What an `order_events.payload` holds. Shape is per `type`; `status_changed` carries `{ from, to }`. */
export type OrderEventPayload = Record<string, unknown>

/**
 * **Append-only.** Every state change writes a row and no row is ever updated or
 * deleted — there is no update path in this codebase and there must not be one.
 * A trigger enforces it in the database as well (`drizzle/0006_order_events_append_only.sql`),
 * because a convention is only as good as the next person in a hurry.
 *
 * This is the table you read at 7pm on a Friday when an owner says the order never
 * arrived and a customer says they were charged.
 *
 * - `type` is text, not an enum: `created`, `status_changed`, `payment_succeeded`,
 *   `print_queued`… new kinds arrive with every feature, and none of them are worth
 *   a migration. The machine only ever writes `status_changed`.
 * - `actor` is who did it — a Clerk user id, or `system` for anything automated
 *   (a webhook, a cron). NOT NULL: an audit row that cannot say who is half a row.
 */
export const orderEvents = pgTable('order_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id').notNull().references(() => orders.id),
  type: text('type').notNull(),
  actor: text('actor').notNull(),
  payload: jsonb('payload').$type<OrderEventPayload>().notNull().default({}),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
})

export type Order = typeof orders.$inferSelect
export type NewOrder = typeof orders.$inferInsert
export type OrderItem = typeof orderItems.$inferSelect
export type OrderItemModifier = typeof orderItemModifiers.$inferSelect
export type OrderEvent = typeof orderEvents.$inferSelect
