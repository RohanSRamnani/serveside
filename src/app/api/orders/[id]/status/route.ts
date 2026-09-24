import { and, eq } from 'drizzle-orm'
import { orders } from '@/db/schema'
import { isUuid, withLocation } from '@/repo/scoped'
import { resolveStorefrontSlug } from '@/domain/storefront'
import { reportError } from '@/lib/report'

/**
 * `GET /api/orders/[id]/status?location=<storefront slug>` — the one thing a
 * customer's own phone may ask without a session: where is my order.
 *
 * **Public, and unguessable only because a uuid is.** There are no customer
 * accounts, so there is nothing to authenticate — the order id, handed back at
 * checkout and baked into `statusHref`, is the whole of the credential. Which is
 * exactly why the response is as thin as it is: `{ shortCode, status, paymentStatus,
 * quotedReadyAt, placedAt }` and nothing else. No name, no phone, no line item, no
 * money — an order id that leaks (a shared link, a screenshot, a browser history)
 * must not leak anything about the person who placed it.
 *
 * **Resolution order, exactly**: shape-check the id first (`isUuid`, same rule
 * `createOrder` and the transition route use — a malformed uuid is 22P02 deep inside
 * Postgres, which poisons the transaction, so it is refused before it reaches one);
 * then resolve the slug (`resolveStorefrontSlug`, the same shared lookup the menu and
 * checkout pages use — an unknown slug is a miss here for the same reason it is a 404
 * there); then **one** `withLocation` read naming both `orders.id` **and**
 * `orders.locationId` in its WHERE clause. That second predicate is not decoration:
 * RLS is silently inert for a role that owns the tables (`withLocation` refuses to
 * open a scope for one, but only once it has been asked to), and this is a route a
 * stranger can call at will, all day, forever — `orders/[id]/transition/route.ts`'s
 * `lockById` is the shape this follows, minus the auth this route has none of.
 *
 * **Every miss is the identical `{ error: 'order_not_found' }`, 404.** An unknown
 * slug, a real order asked about through a different restaurant's slug, and an id
 * that is not even shaped like one are all the same sentence — the `api/storefront`
 * no-oracle doctrine applies here for the same reason: told apart, this becomes a way
 * to probe which ids and which slugs are real. A database failure is deliberately
 * not one of them: it throws, and is answered 500, because "no such order" must never
 * be what an outage says.
 *
 * `no-store` unconditionally — this is polled every five seconds by a customer
 * standing at the counter, and a stale copy of "READY" is a customer who left.
 */

export async function GET(
  req: Request,
  ctx: RouteContext<'/api/orders/[id]/status'>,
): Promise<Response> {
  const { id } = await ctx.params

  // Shape-checked before anything else touches a query: a malformed uuid raises
  // 22P02 deep inside Postgres, which poisons the rest of the transaction. Not a
  // 400 — a string that names no order is answered the same as one that names none
  // that exists, which is the doctrine this whole route follows.
  if (!isUuid(id)) return miss()

  const slug = new URL(req.url).searchParams.get('location')
  if (slug === null) return miss()

  try {
    const locationId = await resolveStorefrontSlug(slug)
    if (!locationId) return miss()

    // One scope, one read, both predicates. `location_id` is written into the WHERE
    // clause on top of what RLS already adds — the belt to its braces, and the same
    // reason `ordersRepo.lockById` writes it out for the transition route: this is a
    // read a stranger's browser renders, so "whose order is this" is asserted in SQL
    // and not only by a policy that could, in principle, be misconfigured out from
    // under it.
    const row = await withLocation(locationId, async (tx) => {
      const [found] = await tx
        .select({
          shortCode: orders.shortCode,
          status: orders.status,
          paymentStatus: orders.paymentStatus,
          quotedReadyAt: orders.quotedReadyAt,
          createdAt: orders.createdAt,
        })
        .from(orders)
        .where(and(eq(orders.id, id), eq(orders.locationId, locationId)))
        .limit(1)
      return found
    })
    if (!row) return miss()

    return Response.json({
      shortCode: row.shortCode,
      status: row.status,
      paymentStatus: row.paymentStatus,
      quotedReadyAt: row.quotedReadyAt ? row.quotedReadyAt.toISOString() : null,
      // `createdAt` IS "placed at" — the column is named for what it records, not
      // for what a customer reads, and this is the one place the two names meet.
      placedAt: row.createdAt.toISOString(),
    }, { status: 200, headers: { 'cache-control': 'no-store' } })
  } catch (err) {
    // Opaque, and 500 rather than a miss: a database that is down must not be
    // reported to a customer as "this order does not exist", and must not be
    // cached as one either.
    reportError('[GET /api/orders/:id/status] failed for', id, err)
    return serverError()
  }
}

/**
 * Identical for an unknown slug, a cross-location order, a malformed id and a
 * missing `location` param — see the doctrine above. `no-store`: cached the same as
 * any other answer, this becomes a stale "not found" for an order placed a second
 * after the edge cached the miss.
 */
function miss(): Response {
  return Response.json({ error: 'order_not_found' }, { status: 404, headers: { 'cache-control': 'no-store' } })
}

/** Our fault, said opaquely — a 500 body is where a table name or an id leaks. */
function serverError(): Response {
  return Response.json({ error: 'server_error' }, { status: 500, headers: { 'cache-control': 'no-store' } })
}
