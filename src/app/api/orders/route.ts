import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { locations, orders, orderEvents } from '@/db/schema'
import { withLocation } from '@/repo/scoped'
import { transition } from '@/domain/order-status'
import { createOrder, OrderRejectedError, type CreateOrderInput, type CreateOrderResult } from '@/domain/create-order'
import { createPaymentIntentFor, StripeAccountMissingError } from '@/lib/stripe'

/**
 * Checkout. The one route in this plan a stranger can POST to.
 *
 * It does two things and delegates both: `createOrder` writes the order (and trusts
 * the client for nothing that costs money), then — for a card order only — a
 * PaymentIntent is opened on the restaurant's connected account. What is left here is
 * the HTTP contract, which is the part worth stating precisely:
 *
 *   422 + `{ error: code, message }`   an `OrderRejectedError`. Something the customer
 *                                     can act on: sold out, closed, pick a spice. The
 *                                     `code` is the stable contract, not the message.
 *   503 + `stripe_account_missing`     the restaurant has not finished Stripe
 *                                     onboarding. Not the customer's fault and not
 *                                     permanent, hence 503 rather than 422.
 *   400                                the body is not JSON.
 *   500 + `{ error: 'server_error' }`  our bug, said opaquely. A 500 body is the one
 *                                     place a stack trace, a table name or a Stripe
 *                                     account id leaks to whoever asked.
 *
 * The order is **not** returned in full: the caller gets the id, the short code and
 * (for a card) the client secret. Everything else about an order belongs behind auth.
 */

export async function POST(req: Request): Promise<Response> {
  let input: CreateOrderInput
  try {
    input = (await req.json()) as CreateOrderInput
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  let order: CreateOrderResult
  try {
    order = await createOrder(input)
  } catch (err) {
    return rejection(err)
  }

  // Cash at the counter: nothing to charge, and the order is already at NEW with a
  // ready time on it. A location with no Stripe account can still do this all day.
  if (input.payment !== 'card') {
    return Response.json({ orderId: order.orderId, shortCode: order.shortCode }, { status: 200 })
  }

  try {
    const location = await readLocation(input.locationId)
    const { clientSecret, paymentIntentId } = await createPaymentIntentFor(
      { id: order.orderId, locationId: input.locationId, totalCents: order.totalCents },
      location,
    )
    // Written back immediately: it is how the webhook proves the event it is handed
    // belongs to this order, and the column is UNIQUE so two orders can never share
    // one payment.
    await withLocation(input.locationId, (tx) => tx.update(orders)
      .set({ stripePaymentIntentId: paymentIntentId })
      .where(eq(orders.id, order.orderId)))

    return Response.json({ orderId: order.orderId, shortCode: order.shortCode, clientSecret }, { status: 200 })
  } catch (err) {
    // The order is already committed at PENDING_PAYMENT, and without an intent it can
    // never be paid — so it is cancelled rather than parked forever. `PENDING_PAYMENT
    // → CANCELED` is exactly the "an abandoned checkout has to end somewhere" edge the
    // machine has. Best-effort: a failure to cancel must not replace the real error.
    await abandon(input.locationId, order.orderId, err)

    if (err instanceof StripeAccountMissingError) {
      return Response.json({ error: err.code, message: err.message }, { status: 503 })
    }
    console.error('[POST /api/orders] payment setup failed for order', order.orderId, err)
    return Response.json({ error: 'server_error' }, { status: 500 })
  }
}

/**
 * `OrderRejectedError` is the family the customer is allowed to see; everything else
 * is ours. The base class is what is matched, not the subclasses — a new rejection
 * landing in `create-order.ts` must not need a new branch here.
 */
function rejection(err: unknown): Response {
  if (err instanceof OrderRejectedError) {
    return Response.json({ error: err.code, message: err.message }, { status: 422 })
  }
  console.error('[POST /api/orders] unexpected failure:', err)
  return Response.json({ error: 'server_error' }, { status: 500 })
}

/**
 * `locations` is the tenancy root and carries no RLS, so the stateless driver reads
 * it. Unlike `createOrder`'s own read this one is not inside the order transaction —
 * it only needs the connected account id, which is not a number on the receipt.
 */
async function readLocation(locationId: string) {
  const [location] = await db()
    .select({ id: locations.id, stripeAccountId: locations.stripeAccountId })
    .from(locations).where(eq(locations.id, locationId)).limit(1)
  if (!location) throw new Error(`Unknown location ${locationId}`)
  return location
}

/** Ends an order that can never be paid, with the audit row that says who ended it and why. */
async function abandon(locationId: string, orderId: string, cause: unknown): Promise<void> {
  try {
    await withLocation(locationId, async (tx) => {
      const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update').limit(1)
      // Gone, or already moved on by something else. Either way not ours to cancel.
      if (!order || order.status !== 'PENDING_PAYMENT') return
      const { next, event } = transition(order, 'CANCELED', 'system')
      await tx.update(orders).set({
        status: next,
        canceledAt: new Date(),
        // The reason is stored, and is deliberately not the raw error: it is read back
        // by staff and by the customer, not by us.
        cancelReason: 'Payment could not be set up with Stripe',
      }).where(eq(orders.id, order.id))
      await tx.insert(orderEvents).values({ orderId: order.id, ...event })
    })
  } catch (err) {
    // Swallowed on purpose: the caller is already returning the real failure, and a
    // second one thrown from cleanup would replace it with a worse message.
    console.error('[POST /api/orders] could not cancel unpayable order', orderId, err, '(original cause:', cause, ')')
  }
}
