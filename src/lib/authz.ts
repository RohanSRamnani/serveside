import { and, eq } from 'drizzle-orm'
import { auth } from '@clerk/nextjs/server'
import { db } from '@/db/client'
import { locations, organizations } from '@/db/schema'
import type { Location } from '@/db/schema'

/**
 * The authorization boundary for everything a restaurant's own staff can reach:
 * the kitchen feed, the transition buttons, 86'ing a dish, pausing orders.
 *
 * **`withLocation` is scoping, not authorization, and the difference is the whole
 * of this file.** `withLocation(id, …)` opens whatever location it is handed and RLS
 * then narrows the rows to it — faithfully, for the wrong restaurant, if the wrong id
 * gets that far. Nothing in the repo layer asks whose location it is. So the question
 * "may this session see this location at all" has to be answered here, **before** a
 * scope is opened, and the answer is a single chain:
 *
 *   Clerk session's active org → `organizations.clerk_org_id` → the org that owns
 *   a location with this slug.
 *
 * Note the direction. The org comes first and the slug is resolved *inside* it, never
 * the other way around: `locations.slug` is unique per org and not globally (two
 * restaurants may both call a location `main`), so a slug-first lookup would be a
 * coin toss between tenants. `locations_org_slug_unique` is what makes this one row.
 *
 * `organizations` and `locations` are the tenancy root and carry no RLS, so the
 * stateless `db()` driver reads them — there is nothing to scope to yet, which is
 * precisely why this check has to exist.
 */

/** The session and the location it is allowed to open. Hand `location.id` to `withLocation`. */
export type LocationGranted = {
  ok: true
  /** The Clerk user id. The `actor` on every event a request writes — never `system`. */
  userId: string
  /** The Clerk organization id of the active org, already proven to own the location. */
  orgId: string
  location: Location
}

/**
 * A refusal, already decided down to the status code. Routes turn it into a response
 * with {@link deniedResponse}; a page branches on `status` (401 means "sign in",
 * 403 means "this is not your restaurant").
 */
export type LocationDenied = {
  ok: false
  status: 400 | 401 | 403
  error: 'invalid_input' | 'unauthenticated' | 'forbidden'
  message: string
  /**
   * Clerk's own redirect to the sign-in page, present only on a 401 and only when a
   * real Clerk session was consulted (route tests mock `auth()`, which has no such
   * thing). A page calls it; an API route must not — a JSON client wants a 401, not
   * a 302 to a login form.
   */
  signIn?: () => never
}

export type LocationAccess = LocationGranted | LocationDenied

/**
 * Resolves the signed-in session against a location slug, or refuses.
 *
 * Takes the slug rather than the request so the caller decides where it comes from:
 * the feed reads `?location=`, the tablet page reads its own route segment. `null`
 * or blank is a 400 — it is answered before the session is even consulted, because
 * there is nothing to authorize against, and because answering it differently for a
 * signed-in user would say something about the slug.
 */
export async function requireLocationAccess(locationSlug: string | null | undefined): Promise<LocationAccess> {
  const slug = locationSlug?.trim()
  if (!slug) {
    return { ok: false, status: 400, error: 'invalid_input', message: 'No location named.' }
  }

  const session = await auth()
  if (!session.userId) {
    // `redirectToSignIn` is a closure Clerk builds per call; it is re-wrapped rather
    // than passed by reference so it cannot be separated from the object it came from.
    const signIn = typeof session.redirectToSignIn === 'function'
      ? (): never => session.redirectToSignIn()
      : undefined
    return { ok: false, status: 401, error: 'unauthenticated', message: 'Sign in to open this feed.', signIn }
  }
  // Signed in with a personal account rather than a restaurant selected. There is no
  // org to map, so there is nothing that could authorize this — and it is a 403
  // rather than a 400 because the fix is switching org, not fixing the request.
  if (!session.orgId) {
    return { ok: false, status: 403, error: 'forbidden', message: 'Select a restaurant to open its feed.' }
  }

  const [location] = await db()
    .select({
      id: locations.id,
      orgId: locations.orgId,
      name: locations.name,
      slug: locations.slug,
      address: locations.address,
      timezone: locations.timezone,
      phoneE164: locations.phoneE164,
      prepTimeMinutes: locations.prepTimeMinutes,
      taxRateBps: locations.taxRateBps,
      pickupEnabled: locations.pickupEnabled,
      deliveryEnabled: locations.deliveryEnabled,
      stripeAccountId: locations.stripeAccountId,
      status: locations.status,
      createdAt: locations.createdAt,
    })
    .from(locations)
    .innerJoin(organizations, eq(organizations.id, locations.orgId))
    .where(and(eq(organizations.clerkOrgId, session.orgId), eq(locations.slug, slug)))
    .limit(1)

  // **One answer for two questions, on purpose.** "That slug belongs to someone else"
  // and "that slug belongs to nobody" are the same 403 with the same body: told apart,
  // this route becomes a way to enumerate the platform's restaurants one guess at a
  // time, and a 404 would confirm each hit. Nothing about the other tenant comes back.
  if (!location) {
    return { ok: false, status: 403, error: 'forbidden', message: 'No such location for this restaurant.' }
  }

  return { ok: true, userId: session.userId, orgId: session.orgId, location }
}

/** The refusal as JSON, for a route handler. Never the page — see {@link LocationDenied.signIn}. */
export function deniedResponse(denied: LocationDenied): Response {
  return Response.json({ error: denied.error, message: denied.message }, { status: denied.status })
}
