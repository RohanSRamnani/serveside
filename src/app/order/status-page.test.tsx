import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { buildMenuSnapshot } from '@/domain/snapshot'
import { seedLocationWithMenu, seedPaidOrder } from '@/test/seed'
import { formatPhone } from './[location]/storefront-copy'
import StatusPage from './[location]/status/[orderId]/page'

/**
 * `/order/[location]/status/[orderId]` end to end, minus the browser — the same
 * shape `browse.test.tsx` DB-tests `/order/[location]` with: a server component is
 * an ordinary async function, so it is called as one and its element rendered, which
 * covers slug resolution → the scoped read → the client component's first paint,
 * against a real database.
 *
 * **The 404 doctrine, asserted on the PAGE and not only on the API route.** The two
 * are separate code paths that happen to share a shape; a bug that broke only one of
 * them would not be caught by the other's tests. Every miss here throws Next's
 * `notFound()` sentinel, which `render` surfaces as a rejection.
 */

function render(location: string, orderId: string): Promise<string> {
  return StatusPage({
    params: Promise.resolve({ location, orderId }),
    // Stripe's redirect return lands here with `payment_intent` and friends on the
    // query string; the page reads none of it (see page.tsx), but `PageProps` still
    // requires the field — `browse.test.tsx` passes the same empty resolve for
    // `/order/[location]`.
    searchParams: Promise.resolve({}),
  }).then(renderToStaticMarkup)
}

const NOT_FOUND = /NEXT_HTTP_ERROR_FALLBACK;404/

describe('/order/[location]/status/[orderId]', () => {
  it('paints the order on the server — short code, strip and quote, resolved by the public slug', async () => {
    const loc = await seedLocationWithMenu()
    const { order } = await seedPaidOrder(loc.id)

    const markup = await render(loc.storefrontSlug, order.id)
    expect(markup).toContain(order.shortCode)
    expect(markup).toContain(loc.name)
    expect(markup).toContain('Order placed')
    // The phone came off the SAME `withLocation` read as the order — `storefrontView`
    // and the order select cannot disagree about which restaurant this is.
    expect(markup).toContain(formatPhone(loc.phoneE164))
  })

  it('is a 404 for a malformed order id', async () => {
    const loc = await seedLocationWithMenu()
    await expect(render(loc.storefrontSlug, 'not-a-uuid')).rejects.toThrow(NOT_FOUND)
  })

  it('is a 404 for a slug nobody owns', async () => {
    await expect(render('no-such-restaurant-at-all', '00000000-0000-4000-8000-000000000000'))
      .rejects.toThrow(NOT_FOUND)
  })

  it('is a 404 for the internal slug, which is not a customer’s key', async () => {
    const loc = await seedLocationWithMenu()
    const { order } = await seedPaidOrder(loc.id)
    // `locations.slug` is org-scoped and internal; the public route resolves only
    // `storefront_slug`. Handed the wrong key this finds nothing, which is correct.
    await expect(render(loc.slug, order.id)).rejects.toThrow(NOT_FOUND)
  })

  it('is a 404 for a real order asked about through a DIFFERENT restaurant’s slug', async () => {
    const mine = await seedLocationWithMenu()
    const theirs = await seedLocationWithMenu()
    const { order } = await seedPaidOrder(mine.id)
    // `theirs` is a real, launched restaurant — its own pinned menu, not just a menu
    // that has never been snapshotted — so this 404 is the location predicate
    // refusing a cross-tenant order id, not `NoMenuError` answering for a restaurant
    // that has not gone live. `seedLocationWithMenu` alone leaves no snapshot row,
    // which would make this pass for the wrong reason.
    await buildMenuSnapshot(theirs.id)

    await expect(render(theirs.storefrontSlug, order.id)).rejects.toThrow(NOT_FOUND)
  })

  it('is a 404 for a well-formed id that names no order at all', async () => {
    const loc = await seedLocationWithMenu()
    await buildMenuSnapshot(loc.id)
    await expect(render(loc.storefrontSlug, '00000000-0000-4000-8000-000000000000')).rejects.toThrow(NOT_FOUND)
  })
})
