import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { locations, menuItems, menuSnapshots } from '@/db/schema'
import { withLocation } from '@/repo/scoped'
import { buildMenuSnapshot } from '@/domain/snapshot'
import { seedLocationWithMenu, seedBusinessHours, type SeededMenu } from '@/test/seed'

/**
 * The public menu endpoint — the one route in this plan that anyone on the internet
 * can GET, with no session, no key and nothing to prove.
 *
 * Two properties are under test, and only one of them is the payload:
 *
 * - **No existence oracle.** A slug nobody owns, a slug shaped like an attack, and a
 *   real restaurant that has not pinned a menu yet all answer the *same* empty 404.
 *   Told apart, this route becomes a way to enumerate the platform's restaurants one
 *   guess at a time — the same reasoning as `requireLocationAccess`'s single 403 and
 *   the CloudPRNT route's empty-bodied 404.
 * - **The cache header**, which is how browsing survives a database blip: the CDN
 *   keeps serving a menu it already has while the origin is unwell.
 */

const { GET } = await import('./storefront/[location]/route')

function get(slug: string): Promise<Response> {
  return GET(
    new Request(`https://serveside.test/api/storefront/${encodeURIComponent(slug)}`),
    { params: Promise.resolve({ location: slug }) },
  )
}

/** A restaurant a customer could actually open: menu, hours, and a pinned snapshot. */
async function storefront(over: Parameters<typeof seedLocationWithMenu>[0] = {}): Promise<SeededMenu> {
  const loc = await seedLocationWithMenu(over)
  await seedBusinessHours(loc.id)
  await buildMenuSnapshot(loc.id)
  return loc
}

/** The exact 404 every miss must be indistinguishable from: no body at all. */
async function expectAnonymousMiss(res: Response, why: string): Promise<void> {
  expect(res.status, why).toBe(404)
  expect(await res.text(), why).toBe('')
  // Nothing about a miss is worth caching at the edge for five minutes; a menu that
  // appears a second later must not be a 404 for the rest of the window.
  expect(res.headers.get('cache-control'), why).toBe('no-store')
}

describe('GET /api/storefront/[location]', () => {
  it('serves the pinned menu, open state and location to anyone who asks', async () => {
    const loc = await storefront({ stripeAccountId: 'acct_test_public' })

    const res = await get(loc.storefrontSlug)
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.location).toEqual({
      name: loc.name,
      // The public key, echoed back: what `/order/[slug]` resolves, not the
      // org-scoped `locations.slug` the authed routes use.
      slug: loc.storefrontSlug,
      timezone: loc.timezone,
      phoneE164: loc.phoneE164,
      address: loc.address,
      prepTimeMinutes: loc.prepTimeMinutes,
      // Display-only, for the cart's tax line. The authoritative number comes back
      // from `POST /api/orders`, which recomputes it on the location row.
      taxRatePer100k: loc.taxRatePer100k,
      // **On an unauthenticated route on purpose.** A connected account id is an
      // identifier, not a credential: it is in the `Stripe-Account` header of every
      // Stripe.js call the customer's browser makes, so a direct charge cannot be
      // confirmed without it being on the wire. Holding one lets nobody charge, read
      // or move anything — the client secret authorises the confirm, and the webhook
      // checks `event.account` against this same column before flipping an order.
      stripeAccountId: 'acct_test_public',
    })
    expect(body.open).toEqual({ open: true })
    expect(body.snapshotVersion).toBeGreaterThan(0)
    expect(body.categories[0].items.map((item: { name: string }) => item.name))
      .toEqual(['Butter Chicken', 'Lamb Rogan Josh'])
  })

  it('resolves the public key only, never the internal one', async () => {
    // Two keys, and only one of them is public. `locations.slug` is org-scoped: it
    // is what `requireLocationAccess` resolves *inside* a Clerk org, and it is
    // ambiguous across tenants by design. A customer has no org, so the public route
    // resolves `storefront_slug` and nothing else — handed the internal slug it must
    // answer the ordinary miss, not the restaurant's menu.
    const loc = await storefront()

    expect((await get(loc.storefrontSlug)).status).toBe(200)
    await expectAnonymousMiss(await get(loc.slug), 'internal org-scoped slug')
  })

  it('lets the edge keep serving the menu while the origin is unwell', async () => {
    const loc = await storefront()
    const cacheControl = (await get(loc.storefrontSlug)).headers.get('cache-control') ?? ''
    // Thirty seconds fresh, then five minutes of "serve the old one and go and look" —
    // which is the whole of browse surviving a database blip.
    expect(cacheControl).toContain('s-maxage=30')
    expect(cacheControl).toContain('stale-while-revalidate=300')
  })

  it('answers every miss the same way, so it cannot be used to find restaurants', async () => {
    const real = await storefront()

    // Nobody's slug.
    await expectAnonymousMiss(await get(`${real.storefrontSlug}-not-a-restaurant`), 'unknown slug')

    // A real restaurant that has not pinned a menu yet. Byte-identical to the above
    // on purpose: "no such restaurant" and "that one is not ready" are the same answer.
    const unpinned = await seedLocationWithMenu()
    await seedBusinessHours(unpinned.id)
    await expectAnonymousMiss(await get(unpinned.storefrontSlug), 'no snapshot')

    // Shapes that are not slugs at all, clamped before anything is queried or logged.
    for (const junk of ['../../etc/passwd', "' or 1=1 --", 'a'.repeat(300), '', 'x\ny']) {
      await expectAnonymousMiss(await get(junk), `junk slug: ${JSON.stringify(junk)}`)
    }
  })

  it('cannot be put in the position of guessing between two restaurants', async () => {
    // Task 1 shipped a refusal branch for a slug two tenants share, because
    // `locations.slug` is unique **per org** only and serving either one would put a
    // restaurant's menu at another's URL — an order from it sends real food to the
    // wrong kitchen. Task 1.5 moved the route onto `storefront_slug`, which is unique
    // **platform-wide**, so the ambiguity is now refused a layer lower down: the
    // database will not store it. The branch stays in the route as defence in depth
    // (a constraint can be dropped by a future migration; the ruling should outlive
    // it), and what is asserted here is the guarantee that makes it unreachable.
    const shared = `shared-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const first = await storefront()
    const second = await storefront()
    await db().update(locations).set({ storefrontSlug: shared }).where(eq(locations.id, first.id))

    const err = await db().update(locations).set({ storefrontSlug: shared })
      .where(eq(locations.id, second.id))
      .then(() => null, (e: unknown) => e)
    expect(err, 'a second location must not be able to take a live storefront slug').not.toBeNull()

    // And the refused write changed nothing: the slug still names exactly one
    // restaurant, and the other one still answers at its own key.
    const body = await (await get(shared)).json()
    expect(body.location.name).toBe(first.name)
    expect(body.location.slug).toBe(shared)
    expect((await get(second.storefrontSlug)).status).toBe(200)
  })

  it('serves one restaurant its own menu and never the one next door', async () => {
    const mine = await storefront()
    const theirs = await seedLocationWithMenu()
    await seedBusinessHours(theirs.id)
    await withLocation(theirs.id, (tx) => tx.update(menuItems)
      .set({ name: 'Next Door Curry' }).where(eq(menuItems.id, theirs.items[0].id)))
    await buildMenuSnapshot(theirs.id)

    const body = await (await get(mine.storefrontSlug)).json()
    const names = body.categories.flatMap((c: { items: { name: string }[] }) => c.items).map((i: { name: string }) => i.name)
    expect(names).not.toContain('Next Door Curry')
  })

  it('writes nothing — a stranger cannot make us pin a menu by asking for one', async () => {
    // The read-only rule at the HTTP boundary. `getOrBuildCurrentSnapshot` exists and
    // is one import away, and used here it would let anyone on the internet write a
    // `menu_snapshots` row per request — and mint menu evidence nobody at the
    // restaurant ever approved. The GET must find a snapshot or find nothing.
    const loc = await seedLocationWithMenu()
    await seedBusinessHours(loc.id)

    await expectAnonymousMiss(await get(loc.storefrontSlug), 'no snapshot')
    const pinned = await withLocation(loc.id, (tx) => tx.select().from(menuSnapshots)
      .where(eq(menuSnapshots.locationId, loc.id)))
    expect(pinned).toHaveLength(0)
  })
})
