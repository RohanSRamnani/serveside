import { and, desc, eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { locations, menuSnapshots } from '@/db/schema'
import type { SnapshotCategory } from '@/db/schema'
import { withLocation, type ScopedTx } from '@/repo/scoped'
import { isOpenAt, type OpenState } from './hours'
import { reportError } from '@/lib/report'

/**
 * What a customer's phone is handed when they open a restaurant's menu.
 *
 * **Browse reads the pinned snapshot, never the live menu tables**, and everything
 * else here follows from that one rule:
 *
 * - **It survives an outage.** The payload is a single `jsonb` column on a single
 *   row. Nothing about rendering a menu touches `menu_items`, `modifier_groups` or
 *   the six-table join `buildMenuSnapshot` walks, so a write path that is unwell
 *   does not take the menu down with it — and the CDN header on the route in front
 *   of this keeps serving the last good copy while the origin recovers.
 * - **It cannot disagree with the price a customer is charged.** `createOrder` pins
 *   `getOrBuildCurrentSnapshot`, which is this same "newest per location" row. When
 *   the two *do* disagree — a dish 86'd between browse and checkout — the customer
 *   meets a rejection `createOrder` already produces by name. That is the designed
 *   behaviour, not a gap to paper over.
 *
 * **Strictly read-only, and that is load-bearing.** `getOrBuildCurrentSnapshot` is
 * one import away and must never be used from here: this runs on an unauthenticated
 * public GET, so building would let anyone on the internet write a `menu_snapshots`
 * row per request, and would mint priced menu evidence nobody at the restaurant ever
 * approved. A location with no snapshot is {@link NoMenuError} — a refusal, not a build.
 */

/**
 * The restaurant, as a customer needs it and no further.
 *
 * Deliberately a projection of the `locations` row rather than the row itself. It is
 * a public payload: `orgId`, the internal `slug` and the rest are not a customer's
 * business, and a `select *` here would put whatever column lands on that table next
 * onto the open internet by default. Every field below is here because a customer's
 * screen would be wrong without it.
 *
 * `timezone` earns its place because every time the storefront renders — today's
 * hours, the pickup quote — is the **restaurant's** wall clock, never the phone's
 * (the `renderTicket` rule, now binding on the web). `prepTimeMinutes` is the live
 * quote; `phoneE164` is what a customer taps when something has gone wrong.
 */
export type StorefrontLocation = {
  name: string
  /**
   * **`locations.storefront_slug`, not `locations.slug`.** The public routing key —
   * platform-unique, what `/order/[slug]` and this view's own route resolve, and
   * therefore the only slug a link built from this payload may use. `locations.slug`
   * is the org-scoped internal key the authed feed/86/pause routes resolve inside a
   * Clerk org, and it is deliberately not published here: it is ambiguous across
   * tenants, so a URL built from it is a coin toss.
   */
  slug: string
  timezone: string
  phoneE164: string
  address: string
  prepTimeMinutes: number
  /**
   * The sales tax rate, parts per 100,000 — **published on purpose, and only so the
   * cart can show a tax line before there is an order to ask about.**
   *
   * It was excluded from this projection until 2026-09-22 on the grounds that a tax
   * rate is not a customer's business. It is: it is printed on their receipt, it is
   * public law, and without it the cart either hides the tax until checkout (which is
   * the incumbents' trick) or invents it. What stays true is that the number the
   * customer is *charged* is never computed from this: client-side totals are
   * display-only and `POST /api/orders` recomputes tax on the location row inside the
   * transaction that writes the order (`taxCentsFor`, half-up). A stale CDN copy of
   * this rate can therefore make a cart's preview off by a cent; it cannot make a
   * charge wrong.
   */
  taxRatePer100k: number
  /**
   * The restaurant's connected Stripe account — **public by construction**, and null
   * for a restaurant that has not finished onboarding.
   *
   * It was excluded from this projection until 2026-09-22 as "nobody's business",
   * which was wrong in the same way `taxRatePer100k` was wrong: this id is in the
   * `Stripe-Account` header of *every* Stripe.js call the customer's browser makes.
   * A direct charge lives on the restaurant's account, so the browser cannot confirm
   * the payment without naming the account it is on — the id is on the wire either
   * way, and hiding it here would only mean fetching it from somewhere else.
   *
   * It is an **identifier, not a credential**: holding one lets nobody charge, read
   * or move anything. What authorises a confirm is the client secret of an intent we
   * created, and what proves an incoming event is a Connect webhook whose
   * `event.account` matches this column (see the webhook route).
   *
   * Published so the storefront can decide whether the card option exists at all,
   * one screen before the server's `StripeAccountMissingError` would have to say so.
   */
  stripeAccountId: string | null
}

export type StorefrontView = {
  location: StorefrontLocation
  /** From `isOpenAt` verbatim — `paused` and `closed_hours` are two different sentences. */
  open: OpenState
  /**
   * Which pin this menu is. Not decoration: it is how a support conversation about
   * "the website said £12" is settled, and how a client can tell a stale CDN copy
   * from a current one.
   */
  snapshotVersion: number
  /**
   * The snapshot's own categories, **passed through untouched** — including items
   * whose `is86d` is true.
   *
   * Sold-out dishes are marked and kept, never filtered. The UI greys them; hiding
   * them makes the menu look thinner than the restaurant is, and a customer who
   * cannot see the dish they came for assumes it was never sold rather than that it
   * ran out today. Filtering here would also make this view disagree with the row
   * `createOrder` prices against, which is the one thing this whole path exists to
   * prevent.
   */
  categories: SnapshotCategory[]
}

/**
 * The location has never pinned a menu, so there is nothing defensible to show.
 *
 * Distinct from `MenuUnavailableError` (`create-order.ts`), which is about the *live*
 * menu on the write path. This one is about the snapshot, on the read path, and it is
 * a refusal rather than a build for the reason at the top of this file.
 *
 * Carries a `code` like the order rejections so an HTTP layer can act on it without
 * matching on a message — though the public route deliberately answers it with the
 * same empty 404 as any other miss. See the route.
 */
export class NoMenuError extends Error {
  readonly code = 'no_menu'

  constructor(locationId: string) {
    super(`Location ${locationId} has no menu snapshot to serve`)
    this.name = 'NoMenuError'
  }
}

/**
 * What a public storefront slug is allowed to look like, checked **before** the
 * value reaches a query or a log line.
 *
 * Deliberately a shape clamp rather than a validation of any particular slug:
 * `locations.storefront_slug` is `text`, and this only has to guarantee that what
 * goes further is a short, boring token. Without it a megabyte of URL path is a
 * megabyte in the log on every request, on surfaces that have nothing in front of
 * them, and a newline in a slug lets a stranger write their own lines into our logs.
 */
const STOREFRONT_SLUG = /^[A-Za-z0-9_-]{1,64}$/

/**
 * Public storefront slug → location id, for a caller with no org to resolve it
 * inside. `null` is every kind of miss.
 *
 * **Shared by the public API route and the browse page on purpose.** It is the one
 * slug-first lookup in the codebase, and the stake in getting it wrong is not
 * cosmetic — a customer browsing one restaurant's menu at another's URL places an
 * order that sends real food to the wrong kitchen and real money to the wrong Stripe
 * account. Two copies of that rule is one copy that can drift.
 *
 * **It resolves `locations.storefront_slug`, and never `locations.slug`.** The two
 * are different keys for different callers: `slug` is org-scoped and internal, and
 * every authed path resolves the Clerk org first and the slug inside it
 * (`src/lib/authz.ts`), which is what makes two restaurants both calling a location
 * `main` harmless. A customer has no org, so `slug` cannot support this lookup: it is
 * ambiguous by design. Handed an internal slug this finds nothing, which is correct.
 *
 * **The two-match refusal is kept although `locations_storefront_slug_unique` makes
 * it unreachable.** It is defence in depth and cheap: a future migration could drop
 * the constraint and a restore could arrive without it, and picking one of two would
 * be a coin toss between tenants. A dark page gets a phone call within the hour; a
 * wrong menu might never get one. `limit(2)` rather than `limit(1)` because the
 * second row is the whole question.
 *
 * **A synthetic location is nobody's storefront** (`locations.synthetic` — the canary).
 * It has a real, orderable, pinned menu, because the canary orders from it; it answers
 * every public page and endpoint with the same miss as a slug nobody owns, because this
 * lookup is where all of them start. `storefrontView` refuses one by id as well.
 *
 * `locations` carries no RLS — there is nothing to scope to until we know which
 * location this is — so the stateless driver reads it. Everything after this point
 * is ordinary `withLocation` code.
 */
export async function resolveStorefrontSlug(slug: string): Promise<string | null> {
  // Clamped first: everything below either queries with this value or logs it.
  if (!STOREFRONT_SLUG.test(slug)) return null

  const rows = await db()
    .select({ id: locations.id })
    .from(locations)
    .where(and(eq(locations.storefrontSlug, slug), eq(locations.synthetic, false)))
    .limit(2)

  if (rows.length === 0) return null
  if (rows.length > 1) {
    reportError(
      '[storefront] storefront slug', slug, 'names more than one location;',
      'refusing to guess. locations_storefront_slug_unique should have made this',
      'impossible — check that the constraint is still on the table.',
    )
    return null
  }
  return rows[0].id
}

/**
 * One read of a storefront, scoped to one location.
 *
 * Takes a location **id**, not a slug: resolving a slug is the caller's job, and on
 * the public route it is the step that decides whether there is anything to answer at
 * all. Shared by the API route and (Task 2) the server component that renders the
 * first paint, so a customer never sees the menu change shape between load and poll.
 *
 * Pass a `tx` to answer inside a caller's transaction — the open state and the pinned
 * menu then come from one consistent view of the database, which matters because a
 * "we're slammed" pause and a rebuilt snapshot can land between two statements.
 * Without one it opens its own scope, the way `isOpenAt` and `buildMenuSnapshot` do.
 */
export async function storefrontView(locationId: string, tx?: ScopedTx): Promise<StorefrontView> {
  // `locations` is the tenancy root and carries no RLS, so the stateless driver reads
  // it — the same read, for the same reason, as the one inside `isOpenAt`.
  const row = await db().query.locations.findFirst({
    where: eq(locations.id, locationId),
    columns: {
      name: true, storefrontSlug: true, timezone: true, phoneE164: true, address: true,
      prepTimeMinutes: true, taxRatePer100k: true, stripeAccountId: true, synthetic: true,
    },
  })
  // A caller asking about a location that does not exist has a bug; answering "no
  // menu" would hide it behind a plausible-looking refusal. The public route never
  // gets here — it resolves the slug first, and an unresolved slug is a 404.
  if (!row) throw new Error(`Unknown location ${locationId}`)
  // A synthetic location has no storefront. Every public caller already got a miss
  // from `resolveStorefrontSlug`; this is for one that arrives holding the id, and it
  // is the refusal every caller already answers with the ordinary 404.
  if (row.synthetic) throw new NoMenuError(locationId)

  // Named `slug` in the payload and read from `storefront_slug`: the customer-facing
  // view has exactly one slug, and it is the public one. See `StorefrontLocation.slug`.
  const { storefrontSlug, synthetic: _synthetic, ...rest } = row
  const location: StorefrontLocation = { ...rest, slug: storefrontSlug }

  if (!tx) return withLocation(locationId, (scoped) => read(locationId, location, scoped))
  return read(locationId, location, tx)
}

/** The two scoped reads: the pinned menu, and whether the doors are open right now. */
async function read(
  locationId: string,
  location: StorefrontLocation,
  tx: ScopedTx,
): Promise<StorefrontView> {
  // **Ordered by version, not `createdAt`** — version is the thing that is unique and
  // monotonic per location, and two snapshots can share a millisecond. Same ordering
  // as `getOrBuildCurrentSnapshot`, deliberately not shared with it: that one is on
  // the order write path and selects ids only, and pulling a whole menu's `jsonb`
  // through it would cost every ticket on a Friday night a copy of the menu.
  //
  // The `location_id` predicate is written out even though RLS already supplies it,
  // for the reason `orders-repo.ts` gives: this is a read a browser renders, and it
  // must not depend on a policy being live.
  const [pinned] = await tx
    .select({ version: menuSnapshots.version, payload: menuSnapshots.payload })
    .from(menuSnapshots)
    .where(eq(menuSnapshots.locationId, locationId))
    .orderBy(desc(menuSnapshots.version))
    .limit(1)
  if (!pinned) throw new NoMenuError(locationId)

  return {
    location,
    // On the same `tx`, so "open" and "this menu" are one instant of the database.
    open: await isOpenAt(locationId, new Date(), tx),
    snapshotVersion: pinned.version,
    categories: pinned.payload.categories,
  }
}
