import type Stripe from 'stripe'
import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { locations, orders, orderEvents, webhookEvents } from '@/db/schema'
import { withLocation, isUuid } from '@/repo/scoped'
import { transition } from '@/domain/order-status'
import { stripe } from '@/lib/stripe'
import { env } from '@/lib/env'
import { sendOrderCreated } from '@/inngest/client'

/**
 * Where a card order becomes the kitchen's problem.
 *
 * The order of operations here is the whole design, and it is not interchangeable:
 *
 *   1. **Verify the signature.** Before anything is read from the body and before a
 *      single row is written. Everything below trusts the payload completely — it
 *      decides which order to mark paid and which tenant to open — so the signature
 *      is the only thing standing between a stranger with the URL and a free dinner.
 *   2. **Claim the event.** One `INSERT ... ON CONFLICT DO NOTHING` on
 *      `webhook_events.external_id`. Zero rows back means this delivery is a
 *      duplicate and someone else already has it: answer 200 and stop. Stripe *will*
 *      deliver twice, and without this the second delivery re-flips the order,
 *      re-quotes the ready time and prints a second ticket.
 *   3. **Handle it**, then 200.
 *
 * **Why 200 is the usual answer, even when nothing happened.** Stripe retries any
 * 5xx, with backoff, for days. So a state that will never change on retry — an order
 * already flipped, an event type we do not care about, metadata that does not name an
 * order — is success, logged. A 5xx is reserved for the failures a retry could
 * genuinely fix, and those release the claim on the way out so the retry lands on a
 * clean id rather than a burnt one.
 */

/** Stripe never sends a body big enough to want streaming, and never sends anything but JSON. */
function ok(body: Record<string, unknown> = { received: true }): Response {
  return Response.json(body, { status: 200 })
}

export async function POST(req: Request): Promise<Response> {
  const signature = req.headers.get('stripe-signature')
  // No header at all is not a Stripe delivery. Refused before the body is even read.
  if (!signature) return Response.json({ error: 'missing_signature' }, { status: 400 })

  // **`req.text()`, never `req.json()`.** The signature covers the exact bytes Stripe
  // sent; parsing and re-serialising is not byte-identical (key order, number
  // formatting, unicode escapes) and every verification would fail — or worse, pass
  // against a payload that is not the one that was signed.
  const raw = await req.text()

  let event: Stripe.Event
  try {
    event = stripe().webhooks.constructEvent(raw, signature, env('STRIPE_WEBHOOK_SECRET'))
  } catch (err) {
    // Deliberately opaque to the caller: a forged request learns nothing about why.
    console.warn('[stripe webhook] signature rejected:', (err as Error).message)
    return Response.json({ error: 'invalid_signature' }, { status: 400 })
  }

  if (!(await claim(event))) {
    // Already processed. Not an error, and not worth a second look at the payload.
    return ok({ received: true, duplicate: true })
  }

  try {
    if (event.type === 'payment_intent.succeeded') await onPaymentSucceeded(event)
    return ok()
  } catch (err) {
    // The claim is released so Stripe's retry is not delivered onto a burnt id. Note
    // what this does *not* undo: a flip that already committed stays committed, which
    // is correct — the money really did move — and the retry then reads as the
    // legal-state no-op below.
    console.error('[stripe webhook] handling failed, releasing claim:', event.id, err)
    await release(event.id)
    return Response.json({ error: 'handler_failed' }, { status: 500 })
  }
}

/**
 * Takes the event, or reports that someone else already has it.
 *
 * `webhook_events` is platform-global and exempt from RLS on purpose: the row has to
 * be written before anything knows whose event this is, and the tenant is inside the
 * payload. Scoping the claim to a location read out of the body would be scoping to
 * whatever the caller claimed. Written through `db()` (stateless http) for that
 * reason — there is no scope to open.
 */
async function claim(event: Stripe.Event): Promise<boolean> {
  const inserted = await db().insert(webhookEvents).values({
    provider: 'stripe',
    externalId: event.id,
    payload: event as unknown as Record<string, unknown>,
  }).onConflictDoNothing({ target: webhookEvents.externalId }).returning({ id: webhookEvents.id })
  return inserted.length > 0
}

/** Best-effort: a failed release is logged, never thrown — the 500 has already been decided. */
async function release(externalId: string): Promise<void> {
  try {
    await db().delete(webhookEvents).where(eq(webhookEvents.externalId, externalId))
  } catch (err) {
    console.error('[stripe webhook] could not release claim on', externalId, err)
  }
}

/**
 * PENDING_PAYMENT → NEW, paymentStatus → PAID, and a promised ready time — one
 * transaction, three facts that are really one: the kitchen owns this order now.
 *
 * `quotedReadyAt` is set *here* rather than at checkout because a promise made while
 * the customer is still typing a card number is a promise with an unknown amount of
 * it already spent. The clock starts when the money lands.
 */
async function onPaymentSucceeded(event: Stripe.PaymentIntentSucceededEvent): Promise<void> {
  const intent = event.data.object
  const orderId = intent.metadata?.orderId ?? ''
  const locationId = intent.metadata?.locationId ?? ''

  // Both ids are put on the intent by `createPaymentIntentFor`, so a delivery without
  // them is our bug or a hand-made intent — and it is the same bug on every retry.
  // Shape-checked before they reach a query: a malformed uuid is a 22P02 that poisons
  // the transaction, and `withLocation` refuses one outright.
  if (!isUuid(orderId) || !isUuid(locationId)) {
    console.error('[stripe webhook] succeeded intent without usable metadata:', intent.id, intent.metadata)
    return
  }

  // One instant for the whole flip: the ready time the customer is promised and the
  // moment we recorded the payment must not come from two different clocks.
  const paidAt = new Date()

  const flipped = await withLocation(locationId, async (tx) => {
    // FOR UPDATE: two deliveries about one order — `payment_intent.succeeded` and
    // some future second handler — must not both read PENDING_PAYMENT and both flip.
    // The idempotency claim covers a repeat of the *same* event; this covers the rest.
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update').limit(1)

    // RLS filters rather than raising, so an order belonging to another location reads
    // as "not there" — which is exactly the right answer, and not a 500.
    if (!order) {
      console.error('[stripe webhook] no order', orderId, 'in location', locationId, 'for intent', intent.id)
      return false
    }
    // A legal state, not a failure: already flipped by an earlier delivery, or
    // cancelled while the customer was paying (which is a refund's problem, not the
    // state machine's). `transition` would throw here, and a throw means a 5xx, and a
    // 5xx means Stripe retries this forever.
    if (order.status !== 'PENDING_PAYMENT') {
      console.warn('[stripe webhook] order', orderId, 'is', order.status, '— nothing to flip')
      return false
    }
    // The order already named a different intent. Marking it paid against a payment
    // that is not its own is a money error, so it fails closed and loudly rather than
    // guessing which of the two is real.
    if (order.stripePaymentIntentId && order.stripePaymentIntentId !== intent.id) {
      console.error(
        '[stripe webhook] order', orderId, 'holds intent', order.stripePaymentIntentId,
        'but the event is about', intent.id, '— refusing to flip',
      )
      return false
    }

    // `locations` is not under RLS, and is read on `tx` so the prep time that makes the
    // promise is the one in force in the transaction that records it.
    const [location] = await tx
      .select({ prepTimeMinutes: locations.prepTimeMinutes })
      .from(locations).where(eq(locations.id, locationId)).limit(1)
    if (!location) throw new Error(`Unknown location ${locationId} on intent ${intent.id}`)

    // The machine decides the move and hands back the event to append with it — the
    // two are written together or not at all.
    const { next, event: moved } = transition(order, 'NEW', 'stripe')

    await tx.update(orders).set({
      status: next,
      paymentStatus: 'PAID',
      quotedReadyAt: new Date(paidAt.getTime() + location.prepTimeMinutes * 60_000),
      // `??`, not an overwrite: the checkout already wrote this, and the column is
      // UNIQUE. Set here only to heal an order whose checkout died after the intent
      // was created but before the id reached the row.
      stripePaymentIntentId: order.stripePaymentIntentId ?? intent.id,
    }).where(eq(orders.id, order.id))

    await tx.insert(orderEvents).values([
      { orderId: order.id, ...moved },
      // Separate from the status change on purpose: `status_changed` carries the move,
      // and this carries the money. In a chargeback six months from now, "what did
      // Stripe actually tell us, and for how much" is the question being asked.
      {
        orderId: order.id,
        type: 'payment_succeeded',
        actor: 'stripe',
        payload: {
          stripeEventId: event.id,
          paymentIntentId: intent.id,
          amountCents: intent.amount,
          currency: intent.currency,
          orderTotalCents: order.totalCents,
        },
      },
    ])
    return true
  })

  if (!flipped) return

  // **After the commit, never inside it.** The fan-out reads the order row it is told
  // about; fired from inside the transaction it would be handed an id that is not
  // visible yet — or one that a rollback un-writes.
  await sendOrderCreated(orderId, locationId)
}
