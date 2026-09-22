import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { locations } from '@/db/schema'
import { withLocation } from '@/repo/scoped'
import { storefrontView, NoMenuError } from '@/domain/storefront'

/**
 * The menu, to anyone who asks. No session, no key, nothing to prove — a customer
 * standing outside a restaurant with a QR code is the whole of the audience.
 *
 * `GET /api/storefront/<slug>` → 200 `StorefrontView`, or an **empty 404**.
 *
 * Three decisions carry this route, and each of them is about the fact that the
 * caller is a stranger:
 *
 * 1. **No existence oracle.** A slug nobody owns, a slug shaped like an attack, a
 *    restaurant that has not pinned a menu yet, and a slug two restaurants share are
 *    all the same 404 with the same empty body. Told apart, this becomes a way to
 *    enumerate the platform one guess at a time — the same argument as
 *    `requireLocationAccess`'s single 403 and the CloudPRNT route's bodiless 404.
 *    The *reason* is logged, where it is useful to us and invisible to them.
 * 2. **The slug is clamped before it is queried or logged** — the pattern the
 *    CloudPRNT route sets for the same reason. `locations.storefront_slug` is `text`,
 *    so without a clamp a megabyte of path would be a megabyte in the log on every
 *    request, on an endpoint with nothing in front of it, and newlines in a slug
 *    would let a stranger write their own lines into our logs.
 * 3. **It reads; it never writes.** No snapshot is built here — see `NoMenuError` in
 *    `@/domain/storefront`. An unauthenticated GET that could write a row is a
 *    durable side effect a stranger controls.
 *
 * **The cache header is a feature, not tuning.** `s-maxage=30` means the CDN answers
 * almost every customer without touching Postgres at all; `stale-while-revalidate=300`
 * means that when the origin *is* unwell, five minutes of customers still get a menu —
 * the last good one — instead of an error page. Thirty seconds is the lag a menu
 * change takes to reach the street, which is the right trade for a printed-menu
 * business. Misses are `no-store`: a restaurant whose snapshot lands a second later
 * must not be a 404 at the edge for the rest of a window.
 *
 * Route handlers are not cached by Next itself (they run per request unless a segment
 * opts in), so this header is the whole caching story and it lives where it can be
 * read — see `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`.
 */

/** Fresh for 30s at the edge, then five minutes of "serve the old one and go and look". */
const BROWSE_CACHE = 's-maxage=30, stale-while-revalidate=300'

/**
 * What a slug is allowed to look like, checked **before** the value reaches a query
 * or a log line. Deliberately a shape clamp and not a validation of any particular
 * slug: the column is `text`, and this only has to guarantee that what goes further
 * is a short, boring token. A genuine slug longer than this would be unbrowsable,
 * which is a reason to keep slugs short, not to widen the clamp.
 */
const SLUG = /^[A-Za-z0-9_-]{1,64}$/

export async function GET(
  _req: Request,
  ctx: RouteContext<'/api/storefront/[location]'>,
): Promise<Response> {
  const { location: slug } = await ctx.params
  // Clamped first: everything below either queries with this value or logs it.
  if (!SLUG.test(slug)) return miss()

  try {
    const locationId = await resolveSlug(slug)
    if (!locationId) return miss()
    // One scope for the whole answer, so the pinned menu and "are you open" come from
    // one consistent view of the database rather than from two instants a pause could
    // land between.
    const view = await withLocation(locationId, (tx) => storefrontView(locationId, tx))
    return Response.json(view, { status: 200, headers: { 'cache-control': BROWSE_CACHE } })
  } catch (err) {
    if (err instanceof NoMenuError) {
      // A real restaurant, not yet launched. Answered as a miss on purpose: "no such
      // restaurant" and "that one is not ready" are the same sentence to a stranger,
      // and the difference is exactly the oracle this route refuses to be.
      console.warn('[GET /api/storefront]', slug, 'has no pinned menu; answered 404')
      return miss()
    }
    // Opaque, and 500 rather than a miss: a database that is down must not be
    // reported to a customer as "this restaurant does not exist", and must not be
    // cached as one either.
    console.error('[GET /api/storefront] failed for', slug, err)
    return serverError()
  }
}

/**
 * Storefront slug → location id, for a caller with no org to resolve it inside.
 *
 * **It resolves `locations.storefront_slug`, and never `locations.slug`.** The two are
 * different keys for different callers: `slug` is org-scoped and internal — every
 * authed path resolves the Clerk org first and the slug inside it
 * (`src/lib/authz.ts`), which is what makes two restaurants both calling a location
 * `main` harmless. A public customer has no org, so a slug-first lookup is the one
 * thing this route has to do and `slug` cannot support it: it is ambiguous by design.
 * `storefront_slug` is unique platform-wide (`locations_storefront_slug_unique`),
 * which is what makes the lookup a single row. Handed an internal slug, this finds
 * nothing and the route answers its ordinary miss — correct, not a bug.
 *
 * **The two-match refusal below is kept although the constraint now makes it
 * unreachable.** It is defence in depth, and cheap: a future migration could drop the
 * constraint, a restore could arrive without it, and the ruling should outlive either.
 * Picking one of two would be a coin toss between tenants, and the stake is not
 * cosmetic — a customer would browse one restaurant's menu at another's URL and place
 * an order that sends real food to the wrong kitchen and real money to the wrong
 * Stripe account. So two matches is a miss, loudly logged. A dark page gets a phone
 * call within the hour; a wrong menu might never get one.
 *
 * `limit(2)` rather than `limit(1)`: the second row is the whole question.
 *
 * `locations` carries no RLS — there is nothing to scope to until we know which
 * location this is — so the stateless driver reads it. Everything after this point is
 * ordinary `withLocation` code.
 */
async function resolveSlug(slug: string): Promise<string | null> {
  const rows = await db()
    .select({ id: locations.id })
    .from(locations)
    .where(eq(locations.storefrontSlug, slug))
    .limit(2)

  if (rows.length === 0) return null
  if (rows.length > 1) {
    console.error(
      '[GET /api/storefront] storefront slug', slug, 'names more than one location;',
      'refusing to guess. locations_storefront_slug_unique should have made this',
      'impossible — check that the constraint is still on the table.',
    )
    return null
  }
  return rows[0].id
}

/**
 * Empty, always, and never cached. A body here would be the difference between "no
 * such restaurant" and "not ready yet", and on an unauthenticated route that
 * difference is an oracle for asking which restaurants exist.
 */
function miss(): Response {
  return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } })
}

/** Our fault, said opaquely — a 500 body is where a table name or an id leaks. */
function serverError(): Response {
  return Response.json({ error: 'server_error' }, {
    status: 500,
    headers: { 'cache-control': 'no-store' },
  })
}
