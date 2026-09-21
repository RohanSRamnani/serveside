/**
 * The order fan-out, as a name the payment path can call before the thing behind it
 * exists. **Task 10 replaces this body** with `inngest.send({ name: 'order/created',
 * data: { orderId, locationId } })` and the `orderCreated` function that queues the
 * print job and texts the owner. The export name and signature are the contract;
 * Task 9 is the only caller today.
 *
 * `locationId` is a parameter rather than something the worker looks up, and that is
 * not convenience: every order read goes through `withLocation`, and a worker holding
 * only an `orderId` has no scope to open and would find the row hidden by RLS.
 *
 * **Two obligations for whoever fills this in.** Both are load-bearing for the
 * webhook that calls it:
 *
 * 1. **It must be idempotent per order.** The caller is a Stripe webhook, and Stripe
 *    delivers twice. `webhook_events` stops a *re-delivered event* reaching here, but
 *    two genuinely different events about one order are still possible — key the
 *    Inngest event on `orderId` so the second one dedupes rather than printing a
 *    second ticket.
 * 2. **It must throw on failure, not swallow.** The webhook releases its idempotency
 *    claim and returns a 5xx when this rejects, which is what makes Stripe retry a
 *    fan-out that never happened. A silent failure here is an order that is paid,
 *    flipped, and that no kitchen ever hears about.
 */
export async function sendOrderCreated(orderId: string, locationId: string): Promise<void> {
  // Deliberately inert, and deliberately not a `console.log` in production code.
  // Task 10 owns the real send.
  void orderId
  void locationId
}
