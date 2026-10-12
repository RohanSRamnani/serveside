import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { locations } from '@/db/schema'
import { withLocation } from '@/repo/scoped'
import { NoMenuError, resolveStorefrontSlug, storefrontIndexable, storefrontView } from '@/domain/storefront'
import { todayServiceWindows, type ServiceWindow } from '@/domain/hours'
import type { StorefrontView } from '@/domain/storefront'
import Browse from './browse'

/**
 * `/order/<storefront-slug>` — the menu, to anyone with the link.
 *
 * **It reads `storefrontView` directly and hands the whole thing to the client.**
 * No fetch of our own API: a server component calling its own HTTP endpoint pays a
 * second cold start, a second TLS handshake and a second round trip to say something
 * it could have read from the database in one — and on a phone on a restaurant's
 * wifi that is the difference between a menu and a spinner. `/api/storefront` still
 * exists for the voice agent and anything else off-page.
 *
 * **One scope for the whole page**, so the pinned menu, "are you open" and today's
 * hours come from one consistent view of the database rather than from three
 * instants a "we're slammed" pause could land between.
 *
 * Every miss is the same 404, for the reason the API route is written around: told
 * apart, a public page becomes a way to enumerate the platform one guess at a time.
 * An unknown slug, an internal `locations.slug`, a slug two orgs somehow share and a
 * real restaurant that has not pinned a menu yet all land on the same page. A
 * *database* failure is deliberately not one of them — it throws, and Next answers
 * 500, because "this restaurant does not exist" is the one thing an outage must
 * never say.
 */

/**
 * **This page is server-rendered on every request, and there is no route segment
 * config that changes that** — checked against a real `next build && next start`
 * rather than assumed, because the obvious guess is wrong in both directions.
 *
 * `export const revalidate = 30` was written here first, to mirror the API route's
 * `s-maxage=30`. It does nothing: the Neon HTTP driver reads through `fetch`, an
 * uncached `fetch` (the default since Next 15) makes the route dynamically rendered,
 * and a dynamic route ignores the segment's revalidate. The build agrees — the route
 * prints as `ƒ` — and the served response is
 * `cache-control: private, no-cache, no-store`. The line is therefore not here: a
 * config that reads as caching and caches nothing is worse than no config.
 *
 * The upside is that it is *correct*: a dish 86'd five seconds ago is already gone
 * from this page, and nothing can serve a menu from the life of the deployment. The
 * cost is the resilience the API route has and this does not — thirty seconds of
 * edge cache plus five minutes of `stale-while-revalidate` is what lets browsing
 * survive a database blip, and with no cache at all a blip is an error page for a
 * customer standing outside the restaurant.
 *
 * TODO(plan-2/task-7): give browse the API route's staleness budget. It needs a
 * cached read (`unstable_cache` around the two reads, keyed by location) or a CDN
 * header, plus a decision about what a *stale* open-state may say — neither is a
 * one-liner, and Task 7 is "storefront hardening".
 */

export async function generateMetadata(
  { params }: PageProps<'/order/[location]'>,
): Promise<Metadata> {
  const { location: slug } = await params
  const locationId = await resolveStorefrontSlug(slug)
  // A miss gets no name in its title bar either: `notFound()` here would render the
  // 404 before the page could, which is the same answer by a less obvious route.
  if (!locationId) return { title: 'Order online', robots: NOINDEX }

  /**
   * Deliberately its own small read rather than the page's whole view. `locations`
   * is one stateless HTTP query for two columns; reading the snapshot again — or
   * threading React's `cache()` through a path this suite calls as a plain function
   * — would cost a second menu-sized `jsonb` transfer to fill in a `<title>`.
   */
  const row = await db().query.locations.findFirst({
    where: eq(locations.id, locationId),
    columns: { name: true, address: true, status: true },
  })
  if (!row) return { title: 'Order online', robots: NOINDEX }
  const customHost = (await headers()).has('x-tenant-custom-host')

  return {
    title: row.name,
    description: `Order pickup from ${row.name} — ${row.address}. Real-time menu, straight to the kitchen.`,
    // A customer's menu wants to be found — on the restaurant's own address, and only
    // once it is real. `next.config.ts` sends the matching X-Robots-Tag on /order/*.
    robots: storefrontIndexable(row.status, customHost) ? { index: true, follow: true } : NOINDEX,
  }
}

const NOINDEX = { index: false, follow: false }

export default async function OrderPage({ params }: PageProps<'/order/[location]'>) {
  const { location: slug } = await params
  const locationId = await resolveStorefrontSlug(slug)
  if (!locationId) notFound()

  const loaded = await load(locationId, slug)
  if (!loaded) notFound()

  return <Browse view={loaded.view} todayHours={loaded.todayHours} />
}

type Loaded = { view: StorefrontView; todayHours: ServiceWindow[] }

/** The whole page's data, on one transaction. `null` is "no pinned menu", which is a 404. */
async function load(locationId: string, slug: string): Promise<Loaded | null> {
  try {
    return await withLocation(locationId, async (tx) => ({
      view: await storefrontView(locationId, tx),
      todayHours: await todayServiceWindows(locationId, new Date(), tx),
    }))
  } catch (err) {
    if (err instanceof NoMenuError) {
      // A real restaurant, not yet launched. Logged where it is useful to us and
      // invisible to them — a client whose page is dark rings us within the hour,
      // and this line is the answer.
      console.warn('[/order]', slug, 'has no pinned menu; answered 404')
      return null
    }
    throw err
  }
}
