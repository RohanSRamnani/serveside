import { describe, it, expect } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { orders, orderItems, orderItemModifiers, orderEvents, menuItems } from '@/db/schema'
import { buildMenuSnapshot } from '@/domain/snapshot'
import { transition } from '@/domain/order-status'
import { seedLocationWithMenu } from '@/test/seed'
import { rejectionText } from '@/test/errors'

/**
 * One paid pickup order, priced off the seeded menu:
 *   Butter Chicken 1800 + Hot 50 = 1850/unit × 2 = 3700 subtotal
 *   tax 3700 × 875bps = 323.75 → 324 (half up), tip 500 → total 4524
 * The arithmetic lives in Task 8's `createOrder`; these are stored values, written
 * out so nothing here is a magic number.
 *
 * Deliberately not in `src/test/seed.ts`: the order row **is** what this file tests,
 * and Task 7's `seedPaidOrder` is the shared seeder for everyone downstream.
 */
async function seedOrder(overrides: Partial<typeof orders.$inferInsert> = {}) {
  const seeded = await seedLocationWithMenu()
  const snapshot = await buildMenuSnapshot(seeded.id)
  const [order] = await db().insert(orders).values({
    locationId: seeded.id,
    shortCode: 'K7M2',
    channel: 'web',
    fulfillment: 'pickup',
    status: 'NEW',
    paymentStatus: 'PAID',
    contactName: 'Rohan R',
    contactPhone: '+15551234567',
    contactEmail: 'rohan@example.com',
    subtotalCents: 3700,
    taxCents: 324,
    tipCents: 500,
    totalCents: 4524,
    menuSnapshotId: snapshot.id,
    notes: 'no cilantro',
    ...overrides,
  }).returning()
  return { seeded, snapshot, order }
}

async function seedOrderWithLine() {
  const { seeded, order } = await seedOrder()
  const [line] = await db().insert(orderItems).values({
    orderId: order.id,
    menuItemId: seeded.items[0].id,
    nameSnapshot: seeded.items[0].name,
    qty: 2,
    unitPriceCents: 1850,
    lineTotalCents: 3700,
    notes: 'extra sauce',
  }).returning()
  const hot = seeded.modifierOptions.find((o) => o.name === 'Hot')!
  await db().insert(orderItemModifiers).values({
    orderItemId: line.id,
    modifierOptionId: hot.id,
    nameSnapshot: hot.name,
    priceDeltaCents: hot.priceDeltaCents,
  })
  return { seeded, order, line, hot }
}

describe('orders schema', () => {
  it('stores every money column as whole cents, as numbers', async () => {
    const { order } = await seedOrder()
    expect(order.subtotalCents).toBe(3700)
    expect(order.taxCents).toBe(324)
    expect(order.tipCents).toBe(500)
    expect(order.totalCents).toBe(4524)
    // bigint mode 'number': a string here means a float or a bigint got into the
    // money path, and every total downstream would be silently wrong.
    for (const cents of [order.subtotalCents, order.taxCents, order.tipCents, order.totalCents]) {
      expect(typeof cents).toBe('number')
      expect(Number.isInteger(cents)).toBe(true)
    }
  })

  it('defaults the optional money to zero and leaves the lifecycle open', async () => {
    const { order } = await seedOrder()
    expect(order.deliveryFeeCents).toBe(0)
    expect(order.discountCents).toBe(0)
    expect(order.createdAt).toBeInstanceOf(Date)
    expect(order.acceptedAt).toBeNull()
    expect(order.readyAt).toBeNull()
    expect(order.completedAt).toBeNull()
    expect(order.canceledAt).toBeNull()
    expect(order.cancelReason).toBeNull()
    // The customers table lands with retention (Plan 3); contact details are inline until then.
    expect(order.customerId).toBeNull()
    expect(order.scheduledFor).toBeNull()
    expect(order.quotedReadyAt).toBeNull()
    expect(order.stripePaymentIntentId).toBeNull()
  })

  it('takes a scheduled order, a quoted time and a payment intent', async () => {
    const scheduledFor = new Date('2026-09-25T23:30:00Z')
    const quotedReadyAt = new Date('2026-09-25T23:50:00Z')
    const intentId = `pi_${Date.now()}`
    const { order } = await seedOrder({
      channel: 'voice',
      paymentStatus: 'PAY_ON_PICKUP',
      status: 'PENDING_PAYMENT',
      scheduledFor,
      quotedReadyAt,
      stripePaymentIntentId: intentId,
    })
    expect(order.scheduledFor?.toISOString()).toBe(scheduledFor.toISOString())
    expect(order.quotedReadyAt?.toISOString()).toBe(quotedReadyAt.toISOString())
    expect(order.channel).toBe('voice')
    expect(order.paymentStatus).toBe('PAY_ON_PICKUP')
    expect(order.stripePaymentIntentId).toBe(intentId)
  })

  it('refuses an order with no menu snapshot pinned to it', async () => {
    const seeded = await seedLocationWithMenu()
    const text = await rejectionText(() => db().insert(orders)
      // @ts-expect-error — the point of the test, asserted twice over: `null` here
      // does not compile (the directive fails as unused the day the column goes
      // nullable) and the database refuses it at runtime. An order that cannot say
      // what menu it was quoted from is not an order, it is an unanswerable dispute.
      .values({
        locationId: seeded.id,
        shortCode: 'K7M3',
        channel: 'web',
        fulfillment: 'pickup',
        status: 'NEW',
        paymentStatus: 'PAID',
        contactName: 'Rohan R',
        contactPhone: '+15551234567',
        subtotalCents: 100,
        taxCents: 9,
        totalCents: 109,
        menuSnapshotId: null,
      }))
    // The whole failed statement is in the error text, so match the violation, not
    // the column name — the column name is in there either way.
    expect(text).toMatch(/null value in column "menu_snapshot_id"/)
  })

  it('refuses two orders sharing one Stripe PaymentIntent', async () => {
    const intentId = `pi_shared_${Date.now()}`
    await seedOrder({ stripePaymentIntentId: intentId })
    const text = await rejectionText(() => seedOrder({ stripePaymentIntentId: intentId }))
    expect(text).toMatch(/orders_stripe_payment_intent_id_unique/)
  })

  it('refuses negative money', async () => {
    const text = await rejectionText(() => seedOrder({ totalCents: -1 }))
    expect(text).toMatch(/orders_money_non_negative/)
  })
})

describe('order lines', () => {
  it('keeps the name and the price it charged, after the menu moves on', async () => {
    const { seeded, line } = await seedOrderWithLine()
    await db().update(menuItems)
      .set({ name: 'Butter Chicken (Signature)', basePriceCents: 2200 })
      .where(eq(menuItems.id, seeded.items[0].id))

    const [reread] = await db().select().from(orderItems).where(eq(orderItems.id, line.id))
    expect(reread.nameSnapshot).toBe('Butter Chicken')
    expect(reread.unitPriceCents).toBe(1850)
    expect(reread.lineTotalCents).toBe(3700)
    expect(reread.qty).toBe(2)
    expect(reread.notes).toBe('extra sauce')
  })

  it('snapshots the modifier name and delta on the line', async () => {
    const { line, hot } = await seedOrderWithLine()
    const [mod] = await db().select().from(orderItemModifiers).where(eq(orderItemModifiers.orderItemId, line.id))
    expect(mod.nameSnapshot).toBe('Hot')
    expect(mod.priceDeltaCents).toBe(50)
    expect(mod.modifierOptionId).toBe(hot.id)
  })

  it('refuses the same modifier recorded twice on one line', async () => {
    // A retried insert must not quietly double a charge on the record.
    const { line, hot } = await seedOrderWithLine()
    const text = await rejectionText(() => db().insert(orderItemModifiers).values({
      orderItemId: line.id, modifierOptionId: hot.id, nameSnapshot: hot.name, priceDeltaCents: hot.priceDeltaCents,
    }))
    expect(text).toMatch(/order_item_modifiers_order_item_id_modifier_option_id_pk|duplicate key/)
  })

  it('refuses a line of zero items', async () => {
    const { seeded, order } = await seedOrder()
    const text = await rejectionText(() => db().insert(orderItems).values({
      orderId: order.id, menuItemId: seeded.items[0].id, nameSnapshot: 'Butter Chicken',
      qty: 0, unitPriceCents: 1850, lineTotalCents: 0,
    }))
    expect(text).toMatch(/order_items_qty_positive/)
  })
})

describe('order events', () => {
  it('appends the event a status change produces', async () => {
    const { order } = await seedOrder()
    const [event] = await db().insert(orderEvents).values({
      orderId: order.id,
      type: 'status_changed',
      actor: 'user_2abc',
      payload: { from: 'NEW', to: 'ACCEPTED' },
    }).returning()
    expect(event.payload).toEqual({ from: 'NEW', to: 'ACCEPTED' })
    expect(event.at).toBeInstanceOf(Date)
  })

  it('takes what the state machine hands it, with no reshaping in between', async () => {
    // The contract Task 12's feed depends on: `transition` returns a row that inserts
    // as-is once the caller adds the order id. If it ever needs massaging on the way
    // in, the "every state change writes an event" rule has a gap in it — this is the
    // test that fails first, at compile time as much as at runtime.
    const { order } = await seedOrder({ status: 'NEW' })
    const { next, event } = transition(order, 'ACCEPTED', 'user_2abc')
    const [written] = await db().insert(orderEvents).values({ orderId: order.id, ...event }).returning()
    expect(next).toBe('ACCEPTED')
    expect(written.type).toBe('status_changed')
    expect(written.actor).toBe('user_2abc')
    expect(written.payload).toEqual({ from: 'NEW', to: 'ACCEPTED' })
  })

  it('defaults an empty payload rather than null', async () => {
    const { order } = await seedOrder()
    const [event] = await db().insert(orderEvents)
      .values({ orderId: order.id, type: 'created', actor: 'system' }).returning()
    expect(event.payload).toEqual({})
  })

  it('cannot be updated', async () => {
    // Append-only is the whole value of the table: an audit row that can be edited
    // after the fact proves nothing in a dispute. Enforced by trigger, not convention.
    const { order } = await seedOrder()
    const [event] = await db().insert(orderEvents)
      .values({ orderId: order.id, type: 'status_changed', actor: 'user_2abc', payload: { from: 'NEW', to: 'ACCEPTED' } })
      .returning()
    const text = await rejectionText(() => db().update(orderEvents)
      .set({ actor: 'someone_else' }).where(eq(orderEvents.id, event.id)))
    expect(text).toMatch(/append-only/i)

    const [unchanged] = await db().select().from(orderEvents).where(eq(orderEvents.id, event.id))
    expect(unchanged.actor).toBe('user_2abc')
  })

  it('cannot be deleted', async () => {
    const { order } = await seedOrder()
    const [event] = await db().insert(orderEvents)
      .values({ orderId: order.id, type: 'created', actor: 'system' }).returning()
    const text = await rejectionText(() => db().delete(orderEvents).where(eq(orderEvents.id, event.id)))
    expect(text).toMatch(/append-only/i)

    const [survivor] = await db().select().from(orderEvents).where(eq(orderEvents.id, event.id))
    expect(survivor.id).toBe(event.id)
  })

  it('cannot be truncated', async () => {
    const text = await rejectionText(() => db().execute(sql`truncate table order_events`))
    expect(text).toMatch(/append-only/i)
  })
})
