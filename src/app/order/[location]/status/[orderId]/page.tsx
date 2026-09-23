import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { and, eq } from 'drizzle-orm'
import { orders } from '@/db/schema'
import { isUuid, withLocation } from '@/repo/scoped'
import { NoMenuError, resolveStorefrontSlug, storefrontView } from '@/domain/storefront'
import { CartProvider } from '../../cart-provider'
import StatusClient, { type OrderStatusPayload, type StatusLocation } from './status-client'

/**
 * `/order/<storefront-slug>/status/<order-id>` — where both success paths of
 * checkout land: Task 4's pay-at-pickup `router.push`, and Task 5's `onPaid` (an
 * in-place card confirm) and Stripe `return_url` (a redirect-based method, which
 * comes back here directly and never runs `onPaid` at all — see `status-client.tsx`
 * for what that means for the cart).
 *
 * A Stripe redirect return arrives with `payment_intent`, `payment_intent_client_secret`
 * and `redirect_status` on the query string. **They are read by nothing here** — the
 * only thing that may ever mark an order paid is the webhook, so this page ignores
 * them entirely and asks the database what actually happened, the same as a poll five
 * seconds later would.
 *
 * **Built exactly like the menu and checkout pages**: resolve the public slug, one
 * `withLocation` for everything this page needs, every miss the same `notFound()` —
 * told apart, a public page becomes a way to enumerate which order ids and which
 * slugs are real, and there is no reason this, the last page of the funnel, should be
 * more talkative than the first two.
 *
 * `orderId` is shape-checked **before** the slug is even resolved: a malformed uuid
 * names no order under any slug, so there is nothing a database round trip could
 * usefully add — the same ordering `GET /api/orders/[id]/status` uses.
 */

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: 'Order status',
    // Never indexed: a stranger's search result has no business landing on somebody
    // else's order confirmation, and this is the page the checkout success paths
    // push to, not one anybody should arrive at cold.
    robots: { index: false, follow: false },
  }
}

export default async function StatusPage(
  { params }: PageProps<'/order/[location]/status/[orderId]'>,
) {
  const { location: slug, orderId } = await params
  if (!isUuid(orderId)) notFound()

  const locationId = await resolveStorefrontSlug(slug)
  if (!locationId) notFound()

  const loaded = await load(locationId, orderId, slug)
  if (!loaded) notFound()

  const { location, order } = loaded
  return (
    // Keyed by the **public** slug, same as the menu and checkout providers — a cart
    // is only found again under the exact key it was written with.
    <CartProvider slug={location.slug}>
      <StatusClient
        slug={location.slug}
        orderId={orderId}
        location={location}
        initial={order}
      />
    </CartProvider>
  )
}

type Loaded = { location: StatusLocation & { slug: string }; order: OrderStatusPayload }

/**
 * The whole page's data, on **one** transaction — `storefrontView` for the
 * restaurant's name, phone and timezone, and the order's own five status columns —
 * so a customer never reads a name from one instant of the database beside a status
 * from another.
 *
 * `null` covers every miss: no such order at all, or one that belongs to a different
 * location than the URL names. RLS narrows the SELECT to `locationId` already; the
 * predicate is written out anyway, the same belt-and-braces `GET .../status` and
 * `ordersRepo.lockById` both carry — this is a read a stranger's browser renders.
 */
async function load(locationId: string, orderId: string, slug: string): Promise<Loaded | null> {
  try {
    return await withLocation(locationId, async (tx) => {
      const view = await storefrontView(locationId, tx)
      const [row] = await tx
        .select({
          shortCode: orders.shortCode,
          status: orders.status,
          paymentStatus: orders.paymentStatus,
          quotedReadyAt: orders.quotedReadyAt,
          createdAt: orders.createdAt,
        })
        .from(orders)
        .where(and(eq(orders.id, orderId), eq(orders.locationId, locationId)))
        .limit(1)
      if (!row) return null

      return {
        location: {
          slug: view.location.slug,
          name: view.location.name,
          phoneE164: view.location.phoneE164,
          timezone: view.location.timezone,
        },
        order: {
          shortCode: row.shortCode,
          status: row.status,
          paymentStatus: row.paymentStatus,
          quotedReadyAt: row.quotedReadyAt ? row.quotedReadyAt.toISOString() : null,
          placedAt: row.createdAt.toISOString(),
        },
      }
    })
  } catch (err) {
    if (err instanceof NoMenuError) {
      // Unreachable in practice — an order cannot exist without a menu snapshot it
      // pinned (`orders.menu_snapshot_id` is `NOT NULL`), so a real order's location
      // always has at least one. Handled anyway, the same as the menu and checkout
      // pages: a refusal here is a 404 like any other miss, not a 500.
      console.warn('[/order/status]', slug, 'has no pinned menu; answered 404')
      return null
    }
    // A database failure is not a 404: "this order does not exist" is the one thing
    // an outage must never say.
    throw err
  }
}
