import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { locations, orders, orderEvents } from '@/db/schema'
import { withLocation } from '@/repo/scoped'
import { transition } from '@/domain/order-status'
import { createOrder, OrderRejectedError, type CreateOrderInput, type CreateOrderResult } from '@/domain/create-order'
import { createPaymentIntentFor, StripeAccountMissingError } from '@/lib/stripe'
import { sendOrderCreated } from '@/inngest/client'

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
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  if (!hasOrderShape(body)) {
    return Response.json({ error: 'invalid_input', message: 'Malformed order body' }, { status: 422 })
  }
  const input = body

  let order: CreateOrderResult
  try {
    order = await createOrder(input)
  } catch (err) {
    return rejection(err)
  }

  // Cash at the counter: nothing to charge, and the order is already at NEW with a
  // ready time on it. A location with no Stripe account can still do this all day.
  if (input.payment !== 'card') {
    await announce(order, input.locationId)
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
 * Hands a pay-at-pickup order to the fan-out — the ticket, and the owner's text.
 *
 * **This is the only thing that will ever announce such an order.** The Stripe
 * webhook is the fan-out's other caller and it only ever sees card orders; a
 * pay-at-pickup order reaches NEW inside `createOrder` and, without this line, is
 * never rendered, never queued for a printer and never texted about. It exists, it is
 * due in fifteen minutes, and the only place it appears is a tablet somebody has to
 * be looking at.
 *
 * **Gated on the status the domain returned, not on the payment mode.** `NEW` is
 * precisely "the kitchen owns this now", so a payment mode added later that lands
 * there is announced for free, and one that parks at PENDING_PAYMENT cannot leak a
 * ticket for food nobody has paid for.
 *
 * **Failure is logged, not returned.** The order is already committed at NEW by the
 * time this can fail, so a 500 would tell a customer their dinner did not happen when
 * it did — and their retry is a second dinner. Degraded rather than silent: the
 * kitchen feed reads `orders`, so the order is on the board either way. Safe to leave
 * best-effort because `sendOrderCreated` is idempotent per order, so a later re-fire
 * (by hand, or by a future sweep) cannot print a second ticket.
 */
async function announce(order: CreateOrderResult, locationId: string): Promise<void> {
  if (order.status !== 'NEW') return
  try {
    await sendOrderCreated(order.orderId, locationId)
  } catch (err) {
    console.error(
      '[POST /api/orders] order', order.orderId, 'is NEW but could not be announced —',
      'no ticket and no SMS; it is on the kitchen feed only:', err,
    )
  }
}

/**
 * The **structural** guard, and only that: are the containers `createOrder` reaches
 * into actually there. Everything about what is *in* them — uuids, quantities,
 * payment modes, a non-blank phone number — stays in `assertInputShape`, which is
 * where that judgement belongs and where its rejections carry codes.
 *
 * It exists because `createOrder` reads `input.items.length` and
 * `input.contact.name.trim()` before it can validate them, so a body that parses as
 * JSON but omits either throws a `TypeError` — our bug, mapped to an opaque 500, on
 * the one route a stranger can POST to. This is the boundary untrusted JSON crosses,
 * so the cast to `CreateOrderInput` happens after it rather than on the way in.
 */
function hasOrderShape(body: unknown): body is CreateOrderInput {
  if (typeof body !== 'object' || body === null) return false
  const b = body as Record<string, unknown>
  const contact = b.contact as Record<string, unknown> | undefined
  if (typeof contact !== 'object' || contact === null) return false
  if (typeof contact.name !== 'string' || typeof contact.phone !== 'string') return false
  /**
   * Consent is a boolean or it is not there. **Refused rather than coerced**, and
   * this is the one value in this guard that is about more than a dereference: the
   * two shapes a careless form serialiser produces are the strings `'false'` and
   * `'on'`, and both are truthy. Coerced, `'false'` opts a customer into marketing
   * they explicitly declined, which is a legal problem rather than a support ticket.
   *
   * `assertInputShape` refuses it too, with a coded rejection — this is the copy that
   * covers the HTTP boundary, where the value arrives as untrusted JSON.
   */
  if (b.smsMarketingConsent !== undefined && typeof b.smsMarketingConsent !== 'boolean') return false
  if (!Array.isArray(b.items)) return false
  return b.items.every((line) => {
    if (typeof line !== 'object' || line === null) return false
    // Absent is fine and is the common case — a line with no modifiers. `createOrder`
    // defaults it to `[]` and refuses a present-but-not-an-array value itself, with a
    // coded rejection; the guard here only has to keep it from being *iterated* as
    // something non-iterable before that check runs.
    const mods = (line as Record<string, unknown>).modifierOptionIds
    return mods === undefined || Array.isArray(mods)
  })
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
