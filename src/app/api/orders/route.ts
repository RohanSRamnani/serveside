import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { locations, orders, orderEvents, paymentFailovers } from '@/db/schema'
import { withLocation } from '@/repo/scoped'
import { quotedReadyAtFrom, transition } from '@/domain/order-status'
import { createOrder, OrderRejectedError, type CreateOrderInput, type CreateOrderResult } from '@/domain/create-order'
import { createPaymentIntentFor, isStripeOutage, StripeAccountMissingError } from '@/lib/stripe'
import { sendOrderCreated, sendStripeOutage } from '@/inngest/client'
import { reportError } from '@/lib/report'

/**
 * **Sixty seconds — longer than Stripe's worst case, with room for the rest.**
 *
 * A platform's default limit can be far shorter than the intent call's own worst case,
 * `INTENT_WORST_CASE_MS` (25 s against a Stripe that never answers). Killed before that
 * call gives up, the function never reaches the catch that converts the order to
 * pay-at-pickup — and the order is left at PENDING_PAYMENT with no intent, the one
 * state this route must never leave behind. Sixty is Stripe's worst case plus the order
 * transaction before it, the conversion after it and the Inngest send, with margin. The
 * deployment's plan has to permit it — check at deploy time rather than assume.
 *
 * **A bare literal, on purpose.** Next reads segment config out of the source text
 * without running it, and anything else — `25 + 35`, a named constant — is not
 * recognised and silently becomes the platform default. The test that checks this
 * number against `INTENT_WORST_CASE_MS` also checks that it is still a literal.
 */
export const maxDuration = 60

/**
 * Checkout. The one route in this plan a stranger can POST to.
 *
 * It does two things and delegates both: `createOrder` writes the order (and trusts
 * the client for nothing that costs money), then — for a card order only — a
 * PaymentIntent is opened on the restaurant's connected account. What is left here is
 * the HTTP contract, which is the part worth stating precisely:
 *
 *   200 + `{ orderId, shortCode, clientSecret }`
 *                                     a card order, parked at PENDING_PAYMENT with an
 *                                     intent on the restaurant's account to confirm.
 *   200 + `{ orderId, shortCode }`    a pay-at-pickup order, already NEW and already
 *                                     announced to the kitchen.
 *   200 + `{ orderId, shortCode, paidAtPickup: true }`
 *                                     **a card order Stripe could not take.** The
 *                                     order was converted to pay-at-pickup rather than
 *                                     refused — see `failOverToPickup`. There is no
 *                                     client secret and there is no intent; the money
 *                                     is collected at the counter.
 *   422 + `{ error: code, message }`   an `OrderRejectedError`. Something the customer
 *                                     can act on: sold out, closed, pick a spice, too
 *                                     many unpaid orders open today. The `code` is the
 *                                     stable contract, not the message.
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
    /**
     * **Stripe is down: take the order anyway, at the counter.**
     *
     * The alternative is a restaurant with a full dining room whose website says
     * "something went wrong on our side" for as long as Stripe's incident lasts. Every
     * one of those orders goes to the phone or goes nowhere, and none of it is the
     * customer's doing or the restaurant's.
     *
     * Only for a failure that is Stripe's or the network's — `isStripeOutage` is the
     * whole of that judgement and the argument for its shortness is written there.
     * Anything else (a bad key, a permission, a card) falls through to the cancel
     * below, because converting *those* would sell food on the strength of our own bug.
     */
    if (isStripeOutage(err)) {
      // **Every conversion is a Sentry event** — the Stripe error itself, with the order
      // it cost us a card payment on.
      reportError(
        '[POST /api/orders] Stripe could not open an intent for order', order.orderId,
        '— converting it to pay-at-pickup:', err,
      )
      const converted = await failOverToPickup(input.locationId, order)
      if (converted) {
        // After the commit and exactly as the pay-at-pickup branch does it: the order
        // is NEW now, so the ticket and the owner's text are owed. And the conversion is
        // news for us: `raiseStripeOutage` hands it to the alarm, which texts ops once
        // an hour while Stripe stays down. Both best-effort, for the reason `announce`
        // gives — the order is committed either way — and both bounded, so together
        // they cost at most one send's time limit, not two.
        await Promise.all([
          announce(converted, input.locationId),
          raiseStripeOutage(converted.orderId, input.locationId),
        ])
        return Response.json(
          { orderId: order.orderId, shortCode: order.shortCode, paidAtPickup: true },
          { status: 200 },
        )
      }
      // The conversion itself failed, or found the order already moved on by something
      // else. Either way this order has no intent and may not be left at
      // PENDING_PAYMENT, so it goes down the ordinary path below — where `abandon`
      // ends it if it is still ours to end, and the customer is told plainly that
      // nothing was ordered rather than being sent to a status page for an order that
      // is not on any kitchen's board.
      reportError('[POST /api/orders] pay-at-pickup failover did not convert order', order.orderId)
    }

    // The order is already committed at PENDING_PAYMENT, and without an intent it can
    // never be paid — so it is cancelled rather than parked forever. `PENDING_PAYMENT
    // → CANCELED` is exactly the "an abandoned checkout has to end somewhere" edge the
    // machine has. Best-effort: a failure to cancel must not replace the real error.
    await abandon(input.locationId, order.orderId, err)

    if (err instanceof StripeAccountMissingError) {
      return Response.json({ error: err.code, message: err.message }, { status: 503 })
    }
    reportError('[POST /api/orders] payment setup failed for order', order.orderId, err)
    return Response.json({ error: 'server_error' }, { status: 500 })
  }
}

/**
 * Turns a card order that Stripe could not take into a pay-at-pickup order — one
 * transaction, or nothing.
 *
 * **Not `abandon`'s sibling: its opposite.** `abandon` ends an order that can never be
 * paid; this one keeps an order that can still be paid, at the counter, the way every
 * restaurant took money before this product existed. The three facts it writes are one
 * fact — the kitchen owns this order now:
 *
 * - `status` NEW, through the machine, so the move is legal and writes its own event.
 * - `paymentStatus` PAY_ON_PICKUP, which is what the till and the ticket read.
 * - `quotedReadyAt`, from this moment, the same promise the webhook makes when money
 *   lands: the clock starts when the kitchen takes it.
 *
 * **`stripePaymentIntentId` stays null.** No intent was created, and the column is
 * UNIQUE and is how the webhook proves an event belongs to an order. A placeholder
 * there would be a lie a later payment could not be checked against.
 *
 * **`for('update')` and the status guard** are the same pair the webhook's flip uses:
 * the row is locked before it is read, and an order that is no longer PENDING_PAYMENT
 * belongs to whatever moved it. Returns the converted order for the caller to announce
 * — after the commit, never inside it, or the fan-out reads a row that is not visible
 * yet. A throw in here is caught, logged and reported as "did not convert": the caller
 * then falls back to cancelling, because the one state that must never survive this
 * function is PENDING_PAYMENT with no intent.
 *
 * **It also writes the conversion down** — a `payment_failovers` row, in this same
 * transaction, which is what the Stripe-outage alarm counts and stamps. In the same
 * transaction so the two cannot disagree: no converted order without its row, and no
 * row for a conversion that rolled back. The table is platform-wide and not under RLS
 * (see it in `src/db/schema/platform.ts`), so writing it inside a location's scope
 * changes nothing about who can see it.
 */
async function failOverToPickup(
  locationId: string,
  placed: CreateOrderResult,
): Promise<CreateOrderResult | null> {
  const convertedAt = new Date()
  try {
    return await withLocation(locationId, async (tx) => {
      const [order] = await tx.select().from(orders).where(eq(orders.id, placed.orderId)).for('update').limit(1)
      // Gone, or already moved on by something else. Not ours to convert.
      if (!order || order.status !== 'PENDING_PAYMENT') return null

      // `locations` is not under RLS and is read on `tx`, so the prep time that makes
      // the promise is the one in force in the transaction that records it.
      const [location] = await tx
        .select({ prepTimeMinutes: locations.prepTimeMinutes })
        .from(locations).where(eq(locations.id, locationId)).limit(1)
      if (!location) throw new Error(`Unknown location ${locationId}`)

      const { next, event } = transition(order, 'NEW', 'system')
      await tx.update(orders).set({
        status: next,
        paymentStatus: 'PAY_ON_PICKUP',
        quotedReadyAt: quotedReadyAtFrom(convertedAt, location.prepTimeMinutes),
      }).where(eq(orders.id, order.id))

      await tx.insert(orderEvents).values({
        orderId: order.id,
        ...event,
        // The audit row a cook and a customer both read. **Never the raw error**: a
        // Stripe exception names accounts and internals, and this row is rendered on a
        // support screen. What matters six months from now is that this order was not
        // charged and why.
        payload: { ...event.payload, reason: CARD_UNAVAILABLE_REASON },
      })

      await tx.insert(paymentFailovers).values({ orderId: order.id, locationId })

      return { ...placed, status: next }
    })
  } catch (err) {
    reportError('[POST /api/orders] could not convert order', placed.orderId, 'to pay-at-pickup:', err)
    return null
  }
}

/**
 * Tells the Stripe-outage alarm (`src/inngest/stripe-outage-alert.ts`) about a
 * conversion that has just committed. Ids only, keyed on the order.
 *
 * **Best-effort**, like `announce`: the order is committed and the customer's answer
 * does not depend on whether our pager could be reached. A failure here is itself
 * reported — the conversion that triggered it already reached Sentry on its own.
 */
async function raiseStripeOutage(orderId: string, locationId: string): Promise<void> {
  try {
    await sendStripeOutage(orderId, locationId)
  } catch (err) {
    reportError('[POST /api/orders] could not raise the Stripe outage alarm for order', orderId, err)
  }
}

/**
 * Why a card order became a pay-at-pickup one, in words. Stored on the event and read
 * by staff and by the customer — so it says what happened to *their order*, not what
 * Stripe's SDK said to us.
 */
const CARD_UNAVAILABLE_REASON =
  'Card payments were unavailable, so this order was switched to pay at pickup.'

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
 * **Failure is logged and reported, not returned.** The order is already committed at
 * NEW by the time this can fail, so a 500 would tell a customer their dinner did not
 * happen when it did — and their retry is a second dinner. Degraded rather than silent:
 * the kitchen feed reads `orders`, so the order is on the board either way, and every
 * failure is a Sentry event naming the order. Safe to leave best-effort because
 * `sendOrderCreated` is idempotent per order, so a later re-fire (by hand, or by a
 * future sweep) cannot print a second ticket.
 *
 * **A hang is a failure too.** `sendOrderCreated` gives up after
 * `INNGEST_SEND_TIMEOUT_MS`; without that bound a hung Inngest got this function killed
 * at `maxDuration`, and the customer was told nothing was ordered for an order that
 * exists. Note what does *not* catch an order whose announce failed: the stale-order
 * alarm rides this same event, so it never hears of it either. Only the feed shows it
 * — which is why the failure is reported.
 */
async function announce(order: CreateOrderResult, locationId: string): Promise<void> {
  if (order.status !== 'NEW') return
  try {
    await sendOrderCreated(order.orderId, locationId)
  } catch (err) {
    reportError(
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
  reportError('[POST /api/orders] unexpected failure:', err)
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
    reportError('[POST /api/orders] could not cancel unpayable order', orderId, err, '(original cause:', cause, ')')
  }
}
