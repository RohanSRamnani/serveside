import { Inngest } from 'inngest'

/**
 * The Inngest client, and the one event this app sends.
 *
 * Inngest is here for one property: **durable steps**. The order fan-out has to keep
 * going when a leg of it fails, and it has to be able to fail in the middle and
 * resume without repeating what already succeeded. That is not something a
 * `Promise.all` after the webhook's 200 can do.
 */
export const inngest = new Inngest({ id: 'serveside' })

/** The only event in the system today. A const because the sender and the trigger must not drift. */
export const ORDER_CREATED = 'order/created' as const

/**
 * What the fan-out is told. Deliberately **ids only** — no order body, no totals, no
 * customer name.
 *
 * Two reasons, and neither is style. An event payload is stored by Inngest and shown
 * in its dashboard, so a customer's name and phone number in here is our data sitting
 * in a third party's UI for no reason. And an event is a snapshot: a worker that
 * re-reads the order gets the row as it is *now*, which is the only version worth
 * printing.
 *
 * `locationId` travels with the order id rather than being looked up, and that is
 * load-bearing: every order read goes through `withLocation`, and a worker holding
 * only an `orderId` has no scope to open — RLS would hide the row from it completely.
 */
export type OrderCreatedData = { orderId: string; locationId: string }

/**
 * Hand one paid order to the fan-out. Called by the Stripe webhook after the flip
 * commits, and by nothing else today.
 *
 * **Idempotent per order, via the event `id`.** Inngest drops an event whose id it
 * has already seen, so the same order cannot start two runs — which is what lets the
 * webhook re-fire a fan-out it could not prove landed (see the re-fire branch in
 * `src/app/api/stripe/webhook/route.ts`) without printing a second ticket. The dedupe
 * window is 24 hours; the print leg checks `print_jobs` as well, so the guarantee
 * outlives it.
 *
 * **Throws on failure, never swallows.** The webhook releases its idempotency claim
 * and answers 5xx when this rejects, which is what makes Stripe retry a fan-out that
 * never happened. A silent failure here is an order that is paid, flipped, and that
 * no kitchen ever hears about.
 */
export async function sendOrderCreated(orderId: string, locationId: string): Promise<void> {
  await inngest.send({
    name: ORDER_CREATED,
    data: { orderId, locationId } satisfies OrderCreatedData,
    id: `order-created-${orderId}`,
  })
}
