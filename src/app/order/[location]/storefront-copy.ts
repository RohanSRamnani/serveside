import type { OpenState, ServiceWindow } from '@/domain/hours'
import type { StorefrontView } from '@/domain/storefront'

/**
 * The sentences and the links the storefront's pages share.
 *
 * **Extracted so the menu and the checkout cannot say different things.** Both have
 * to tell a customer that the kitchen is shut, and `closedNotice` is the only thing
 * that knows a "we're slammed" pause, a holiday and the weekly grid are three
 * different next moves. A second copy of that wording on the checkout page would be
 * the copy that drifts, and the one that drifts is always the one nobody reads.
 *
 * It is also what keeps the two pages out of a **circular import**. `browse.tsx`
 * needs the checkout href and `checkout-form.tsx` needs the closed notice; with both
 * living in the pages themselves that is a cycle. Here, nothing imports a page.
 *
 * A plain module — **no `'use client'`, and only type imports** — so it is readable
 * from a server component and costs a client bundle nothing but the functions it
 * actually calls. `browse.tsx` re-exports the three its own tests import, so moving
 * them here changed no test.
 */

// ---------------------------------------------------------------------------
// Links.
// ---------------------------------------------------------------------------

/**
 * **Always the public `storefront_slug`**, which is the only slug a customer-facing
 * link may be built from — `locations.slug` is org-scoped and ambiguous across
 * tenants, so a URL built from it is a coin toss between restaurants.
 * `StorefrontLocation.slug` is already the public one; there is no other to reach.
 */
export function menuHref(slug: string): string {
  return `/order/${slug}`
}

export function checkoutHref(slug: string): string {
  return `/order/${slug}/checkout`
}

/** Task 6 builds this page; the href is agreed here so both ends cannot disagree. */
export function statusHref(slug: string, orderId: string): string {
  return `/order/${slug}/status/${orderId}`
}

// ---------------------------------------------------------------------------
// Words.
// ---------------------------------------------------------------------------

/**
 * A phone number as a customer reads one, and **verbatim for anything that is not a
 * plain US number**. `phone_e164` is the storage format and the `tel:` href stays
 * exactly that; this is only the label. A "clever" formatter applied to, say, a
 * +44 number would garble it, so anything that is not `+1` plus ten digits is
 * printed as it was stored.
 */
export function formatPhone(e164: string): string {
  const match = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164)
  if (!match) return e164
  return `(${match[1]}) ${match[2]}-${match[3]}`
}

/**
 * "7:35 PM", on the restaurant's own clock. The shared half of `quoteLabel` and
 * `readyAtLabel` below — one an estimate computed from now, the other a promise
 * already pinned on the order — so the two cannot format the same kind of instant
 * two different ways.
 *
 * The space before AM/PM is normalised. Since ICU 72 (Node 18.14+) `en-US` formats it
 * with U+202F, a narrow no-break space — invisible in a diff, fatal to a string
 * comparison, and the kind of thing that costs an afternoon.
 */
function wallClockTime(at: Date, timezone: string): string {
  const time = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    // Stated rather than left to the locale: a default that ever flipped to 24-hour
    // would silently change what every customer in the country is promised.
    hour12: true,
    timeZone: timezone,
  }).format(at)
  return time.replace(/[  ]/g, ' ')
}

/**
 * "Ready around 7:35 PM" — now plus the restaurant's prep time, **on the
 * restaurant's clock**.
 *
 * The `renderTicket` rule, now binding on the web: a ticket prints the restaurant's
 * wall clock, and so does every time a customer is shown. Someone ordering ahead from
 * another timezone must read the time the kitchen will read, or they arrive hours
 * early — so the zone comes from `locations.timezone` and never from the phone.
 *
 * **It lives here rather than beside the form because the checkout page calls it on
 * the server**, to render the first quote. Every export of a `'use client'` module is
 * a client reference when a server component imports it, so a formatter kept in the
 * form would be a proxy object by the time the page tried to call it. This module has
 * no `'use client'`, so both ends can use it; the form re-exports it for its tests.
 */
export function quoteLabel(now: Date, prepTimeMinutes: number, timezone: string): string {
  const ready = new Date(now.getTime() + prepTimeMinutes * 60_000)
  return `Ready around ${wallClockTime(ready, timezone)}`
}

/**
 * "Ready around 7:35 PM" for a **fixed instant** rather than an estimate — the status
 * page's own quote, once `orders.quoted_ready_at` is a real timestamp the
 * `PENDING_PAYMENT → NEW` flip (or an ACCEPTED bump) already pinned, not "now plus
 * prep time". Same wording and the same restaurant's-clock rule as `quoteLabel`, so a
 * customer reads one sentence on the checkout page and the same shape of sentence on
 * the status page that follows it.
 */
export function readyAtLabel(readyAt: Date, timezone: string): string {
  return `Ready around ${wallClockTime(readyAt, timezone)}`
}

/** `HH:MM:SS` as a customer reads a clock. `24:00:00` is a legal Postgres `time`. */
function wallClock(time: string): string {
  const [hh, mm] = time.split(':')
  const hour = Number(hh)
  if (hour === 0 || hour === 24) return 'midnight'
  const suffix = hour < 12 ? 'AM' : 'PM'
  const twelve = hour % 12 === 0 ? 12 : hour % 12
  return `${twelve}:${mm} ${suffix}`
}

/**
 * Today's posted hours, as one line. Several windows is the normal case — lunch and
 * dinner are two rows of `business_hours`, not one.
 */
export function formatServiceWindows(windows: readonly ServiceWindow[]): string {
  if (windows.length === 0) return 'Closed today'
  // The dev seed's whole-day grid, and any genuine 24-hour kitchen. "midnight –
  // midnight" is not a sentence anybody has ever read off a door.
  if (windows.length === 1 && windows[0].openTime === '00:00:00' && windows[0].closeTime === '24:00:00') {
    return 'Open 24 hours'
  }
  return windows.map((w) => `${wallClock(w.openTime)} – ${wallClock(w.closeTime)}`).join(', ')
}

/**
 * What a closed restaurant tells a customer — or `null`, which is what an open one
 * says about it.
 *
 * The three reasons stay three sentences. `isOpenAt` goes to real trouble to tell a
 * "we're slammed" pause from a dated closure from the weekly grid, and each one is a
 * different next move for the customer: wait a bit, come back another day, come back
 * later today. Flattening them into "closed" throws away the only part of this the
 * customer can act on.
 */
export function closedNotice(
  open: OpenState,
  todayHours: readonly ServiceWindow[],
  resume?: { until: string; timezone: string } | null,
): string | null {
  if (open.open) return null
  if (open.reason === 'paused') {
    const next = resume
      ? `Taking orders again at ${wallClockTime(new Date(resume.until), resume.timezone)}.`
      : 'Try again in a little while.'
    return `Not taking orders right now — the kitchen is slammed. ${next}`
  }
  if (open.reason === 'holiday' || todayHours.length === 0) return 'Closed today.'
  return `Closed right now. Today: ${formatServiceWindows(todayHours)}.`
}

/**
 * Why this storefront cannot take an order right now, or `null` when it can. The one
 * sentence the menu's header, its Checkout button and the checkout page all use.
 *
 * A demo or a switched-off restaurant says so before the clock is asked: "closed right
 * now" on a demo would promise an opening that is never coming.
 */
export function orderingNotice(
  view: Pick<StorefrontView, 'mode' | 'open' | 'pausedUntil' | 'location'>,
  todayHours: readonly ServiceWindow[],
): string | null {
  if (view.mode === 'demo') return `A demo built for ${view.location.name}. Ordering isn't switched on yet.`
  if (view.mode === 'off') return 'Online ordering is off right now.'
  const resume = view.pausedUntil ? { until: view.pausedUntil, timezone: view.location.timezone } : null
  return closedNotice(view.open, todayHours, resume)
}
