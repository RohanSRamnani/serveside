import { clerkMiddleware } from '@clerk/nextjs/server'

/**
 * `proxy.ts`, not `middleware.ts` — Next 16 renamed the convention (the file must
 * still sit beside `app/`, hence `src/proxy.ts`). The function is the same one
 * `clerkMiddleware()` has always returned, which is why it is still imported from
 * `@clerk/nextjs/server`.
 *
 * **It authorizes nothing, on purpose.** Its whole job is to attach the Clerk session
 * to the request so `auth()` can read it inside a route handler or a server
 * component. Every actual decision — is this person signed in, does their active org
 * own this restaurant — lives in `requireLocationAccess` (`src/lib/authz.ts`), next
 * to the data it protects.
 *
 * That split is Clerk's own current guidance, and it is why there is no
 * `createRouteMatcher` here: matching paths in middleware is deprecated in
 * `@clerk/nextjs` 7 precisely because a matcher's idea of which URLs are protected
 * drifts from how Next actually routes them, and the drift fails open. A route that
 * forgets to call `requireLocationAccess` is a route that reads nothing, because
 * `withLocation` still needs a location id that only the check produces.
 *
 * The API routes are deliberately left to answer for themselves: a tablet polling
 * `/api/feed` with a dead session must get a 401 it can show, not a 302 to a login
 * page that its `fetch` would follow and parse as JSON.
 */
export default clerkMiddleware()

/**
 * Broad, minus the endpoints that are **not** people.
 *
 * The exclusions are the point. A Stripe webhook is authenticated by a signature, a
 * CloudPRNT printer by the MAC burnt into it, Inngest by its signing key, and public
 * checkout and the public menu by nothing at all — none of them has a session, and
 * none of them should stop working because a Clerk key is blank, expired or rotated.
 * Left in, they all break: `clerkMiddleware()` throws on a missing publishable key
 * before a request reaches a route, so one unset env var would silently stop a
 * kitchen printing and stop paid orders reaching it.
 *
 * **`order/` is the most visible of them and the reason this list grew** (Task 2): it
 * is the customer's menu, the thing a QR code on a table and a Google listing's
 * "Order Online" button both point at. There is nobody to attach a session *to* —
 * there are no customer accounts — so running it through Clerk buys a public page an
 * auth round trip, a `Set-Cookie` that argues with the page's own 30-second cache,
 * and a hard dependency on a key it never reads. It was inside the matcher until the
 * page existed to notice, and the symptom was the whole storefront answering 500 with
 * a message about `npx clerk init`. `api/storefront/` is the same surface for the
 * voice agent and anything else off-page.
 *
 * Everything else is included rather than allow-listed, so a new authed route — Task
 * 13's `/api/menu/86` and `/api/pause` — is covered the day it lands. That direction
 * is the safe one: the proxy only *attaches* a session, and the decision about what
 * it may open is made in the route by `requireLocationAccess`. A route the proxy
 * wrongly covers loses nothing; a route it wrongly misses makes `auth()` throw.
 *
 * `api/orders$` is anchored so public checkout (`POST /api/orders`) is excluded while
 * `POST /api/orders/<id>/transition`, which is a person tapping a tablet, is not.
 *
 * `api/orders/[^/]+/status$` is Task 6's public status endpoint — a customer's own
 * phone, polling every five seconds, with no session to attach. Anchored the same
 * way `api/orders$` is, and for the same reason: `[^/]+` is the order id, and the
 * `$` is what keeps this from also swallowing `POST /api/orders/<id>/transition`,
 * which is a person on a tablet and must stay behind Clerk.
 *
 * **One string literal, however long.** Next extracts `matcher` by static analysis at
 * build time; a concatenation or a constant it cannot fold is not an error — the
 * matcher is silently dropped and the proxy runs on *every* request, exclusions and
 * all. That failure looks exactly like the exclusions not working.
 */
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico|chime\\.wav|order/|api/stripe/|api/printers/|api/inngest|api/storefront/|api/orders$|api/orders/[^/]+/status$).*)'],
}
