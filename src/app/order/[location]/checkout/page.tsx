import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { withLocation } from '@/repo/scoped'
import { NoMenuError, resolveStorefrontSlug, storefrontView } from '@/domain/storefront'
import { todayServiceWindows, type ServiceWindow } from '@/domain/hours'
import type { StorefrontView } from '@/domain/storefront'
import { CartProvider } from '../cart-provider'
/**
 * **`quoteLabel` comes from `../storefront-copy`, never from `./checkout-form`.**
 *
 * The form re-exports it, and that re-export is unusable here: a `'use client'`
 * module's exports are *all* client references when a server component imports them,
 * re-exports included, so calling it gives "Attempted to call quoteLabel() from the
 * server but quoteLabel is on the client" — a 500 on the whole page. Found exactly
 * that way, in the browser, after a typecheck that could not see it.
 */
import { orderingNotice, quoteLabel } from '../storefront-copy'
import { CheckoutForm } from './checkout-form'

/**
 * `/order/<storefront-slug>/checkout` — the contact, tip and consent step.
 *
 * **Built exactly like the menu page, and deliberately so.** It resolves the public
 * slug, reads the view and today's hours on **one** `withLocation` so "are you open",
 * the prep time and the pinned menu are one instant of the database, and answers
 * every miss with the same `notFound()`. Told apart, a public page is a way to
 * enumerate the platform one guess at a time — and there is no reason for the second
 * page of the funnel to be more talkative than the first.
 *
 * **It resolves the location id here, on the server, and hands it to the form.**
 * `StorefrontView` publishes no id on purpose — it is a public payload, and an
 * internal primary key is not a customer's business — so the id never travels over
 * the wire to get here. It is looked up from the slug the same way the menu page
 * looks it up, and passed down as a prop for the form to post.
 *
 * **The cart is read, not re-fetched.** `CartProvider` is mounted with the same
 * public slug the menu used, so this page reads the very `localStorage` key the
 * customer filled a moment ago (`storageKey`). There is no cart on the server and
 * nothing about the order is in the URL.
 *
 * Rendered per request, with no `revalidate`, for the reason the menu page's own
 * comment gives at length: the Neon HTTP driver reads through an uncached `fetch`,
 * which makes the route dynamic, which makes a segment revalidate a no-op. Doubly
 * right here — a checkout page served from a CDN could quote a closed restaurant.
 */

export async function generateMetadata(
  { params }: PageProps<'/order/[location]/checkout'>,
): Promise<Metadata> {
  const { location: slug } = await params
  return {
    title: 'Checkout',
    /**
     * **Never indexed, and never followed.** A checkout page in a search result is a
     * dead link at best; at worst it is a customer landing on a form with an empty
     * cart and concluding the restaurant is broken. The menu page is the one page on
     * this platform that wants to be found, and it links here itself.
     */
    robots: { index: false, follow: false },
    alternates: { canonical: `/order/${slug}` },
  }
}

export default async function CheckoutPage({ params }: PageProps<'/order/[location]/checkout'>) {
  const { location: slug } = await params
  const locationId = await resolveStorefrontSlug(slug)
  if (!locationId) notFound()

  const loaded = await load(locationId, slug)
  if (!loaded) notFound()

  const { view, todayHours } = loaded
  return (
    // Keyed by the **public** slug from the view, not by the raw URL segment: the
    // menu's provider was keyed that way, and a cart is only found again under the
    // exact key it was written with.
    <CartProvider slug={view.location.slug}>
      <CheckoutForm
        locationId={locationId}
        location={view.location}
        closedReason={orderingNotice(view, todayHours)}
        /**
         * Quoted on the server so the first client render matches the HTML byte for
         * byte — two `new Date()` calls a second apart is a hydration mismatch, and
         * React answers one by throwing the whole tree away. The form re-derives it
         * on mount and keeps it current from there.
         */
        initialQuote={quoteLabel(new Date(), view.location.prepTimeMinutes, view.location.timezone)}
      />
    </CartProvider>
  )
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
      console.warn('[/order/checkout]', slug, 'has no pinned menu; answered 404')
      return null
    }
    // A database failure is not a 404: "this restaurant does not exist" is the one
    // thing an outage must never say.
    throw err
  }
}
