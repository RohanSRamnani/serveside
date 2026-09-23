import { loadStripe } from '@stripe/stripe-js/pure'
// Type-only, so it is erased at build and brings none of the main entry's side
// effect (below) with it.
import type { Stripe } from '@stripe/stripe-js'

/**
 * Stripe.js in the customer's browser — the other half of `src/lib/stripe.ts`.
 *
 * **The platform publishable key plus `{ stripeAccount }` IS the direct-charge
 * browser mechanic.** The server opens the PaymentIntent *on the restaurant's
 * connected account*, so the client secret it hands back names an intent that only
 * exists on that account. A Stripe.js instance built from the platform key alone
 * would send the confirm to the platform account, which has never heard of that
 * intent — the symptom is a card that simply fails, on a key and a secret that are
 * both perfectly valid. The account option is not configuration; it is the sentence
 * "this money is theirs", said in the one place the browser can say it.
 *
 * The key is the **platform's publishable key** and never a connected account's.
 * Publishable keys are public by design — they are in the page source of every site
 * that takes a card — and `NEXT_PUBLIC_` is Next's way of saying exactly that: the
 * value is inlined into the JavaScript bundle at build time. Nothing secret can live
 * behind that prefix.
 *
 * **`@stripe/stripe-js/pure`, not `@stripe/stripe-js`.** Importing the main entry
 * injects Stripe's script on the next microtask, whether or not `loadStripe` is ever
 * called — so every customer who opens a checkout would fetch a quarter of a megabyte
 * of third-party JavaScript and hit Stripe's domain, including the ones paying cash
 * at the counter and every restaurant that has no Stripe account at all. The `pure`
 * entry is the same `loadStripe` with that side effect removed: the script loads on
 * the first call, which is the moment a card order has actually been placed and the
 * Payment Element is about to mount anyway.
 */

/**
 * One Stripe.js client per connected account, for the life of the page.
 *
 * `loadStripe` injects a script tag and resolves a singleton, so calling it per
 * render is wasted work — but the sharper reason is `<Elements>`: handed a new
 * promise it remounts the Payment Element, and a remounted Element throws away the
 * card number the customer was halfway through typing.
 *
 * **Keyed by the account id, and that is not a detail.** One origin serves every
 * restaurant on the platform, so two storefronts can live in one tab's history. A
 * single memoized client would confirm the second restaurant's payment against the
 * first restaurant's account. The publishable key is deliberately *not* part of the
 * key: in a browser it is a build-time constant and cannot change while a page lives.
 */
const clients = new Map<string, Promise<Stripe | null>>()

/**
 * Stripe.js for one restaurant, or `null` when there is nothing to build it from.
 *
 * `null` has exactly two causes, and both are ordinary rather than exceptional:
 *
 * - **No publishable key.** Checked blank-safely, because an unset Vercel variable
 *   arrives as `''` rather than `undefined`, and `loadStripe('')` fails
 *   asynchronously — a dead Payment Element on the one screen that must not break.
 * - **No connected account.** `locations.stripe_account_id` is null for every
 *   restaurant that has not finished onboarding. The checkout hides the card option
 *   for exactly this reason (`cardPaymentAvailable`), so a `null` here is the last
 *   line rather than the first.
 *
 * `process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is written out in full, because
 * Next inlines that expression by **static text substitution**: destructured, aliased
 * or read through a variable it is simply `undefined` in the browser, and card
 * payments would vanish from a correctly configured deployment.
 */
export function stripeBrowser(stripeAccountId: string | null): Promise<Stripe | null> | null {
  const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
  if (typeof publishableKey !== 'string' || publishableKey.trim() === '') return null
  if (typeof stripeAccountId !== 'string' || stripeAccountId.trim() === '') return null

  const existing = clients.get(stripeAccountId)
  if (existing) return existing

  const client = loadStripe(publishableKey, { stripeAccount: stripeAccountId })
  clients.set(stripeAccountId, client)
  return client
}
