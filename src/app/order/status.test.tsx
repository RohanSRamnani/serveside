import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { OrderStatus } from '@/domain/order-status'
import { readyAtLabel } from './[location]/storefront-copy'
import {
  STRIP_STEPS, clearedMarkerKey, isTerminalStatus, shouldClearCartOnArrival,
  shouldKeepPolling, statusPresentation,
} from './[location]/status/status-copy'
import { StatusView } from './[location]/status/[orderId]/status-client'

/**
 * The status page, minus the browser: the strip mapping, the two standing polling
 * and cart decisions, and the markup a customer actually sees — all pure, all
 * renderable with `renderToStaticMarkup`, none of it needing jsdom. The poll itself,
 * the `visibilitychange` listener and the network are `StatusClient`'s `useEffect`s
 * and are the manual/browser check, the same split `feed-client.tsx` draws.
 */

const ALL_STATUSES: OrderStatus[] = [
  'PENDING_PAYMENT', 'NEW', 'ACCEPTED', 'IN_KITCHEN', 'READY', 'COMPLETED', 'REJECTED', 'CANCELED',
]

const KASHI = { name: 'Kashi', phoneE164: '+19735550123', timezone: 'America/New_York' }

// ---------------------------------------------------------------------------
// The strip mapping.
// ---------------------------------------------------------------------------

describe('statusPresentation', () => {
  it('has an exhaustive, non-empty headline for all eight statuses', () => {
    for (const status of ALL_STATUSES) {
      expect(statusPresentation(status).headline, status).toMatch(/\w/)
    }
  })

  it('maps the happy path onto PLACED → ACCEPTED → READY', () => {
    expect(statusPresentation('NEW').activeStep).toBe('PLACED')
    expect(statusPresentation('ACCEPTED').activeStep).toBe('ACCEPTED')
    // IN_KITCHEN shares ACCEPTED's position — a three-word strip has no room for a
    // status most customers never see the order visibly sit in.
    expect(statusPresentation('IN_KITCHEN').activeStep).toBe('ACCEPTED')
    expect(statusPresentation('READY').activeStep).toBe('READY')
    expect(statusPresentation('COMPLETED').activeStep).toBe('READY')
  })

  it('lights nothing for PENDING_PAYMENT and says the money has not landed yet', () => {
    // Webhook lag: the flip to NEW is what pins `quotedReadyAt`, so there is nothing
    // to promise and nothing on the strip to light.
    const p = statusPresentation('PENDING_PAYMENT')
    expect(p.activeStep).toBeNull()
    expect(p.showStrip).toBe(true)
    expect(p.headline).toMatch(/confirming payment/i)
  })

  it('says picked up once COMPLETED, still parked on the READY step', () => {
    expect(statusPresentation('COMPLETED').detail).toMatch(/thanks/i)
  })

  it('leaves the happy path for REJECTED and CANCELED, honestly', () => {
    for (const status of ['REJECTED', 'CANCELED'] as const) {
      const p = statusPresentation(status)
      expect(p.ended, status).toBe(true)
      expect(p.showStrip, status).toBe(false)
      expect(p.activeStep, status).toBeNull()
    }
    expect(statusPresentation('REJECTED').headline).toMatch(/declined/i)
    expect(statusPresentation('CANCELED').headline).toMatch(/canceled/i)
  })

  it('offers three steps, in order, and no more', () => {
    expect([...STRIP_STEPS]).toEqual(['PLACED', 'ACCEPTED', 'READY'])
  })
})

// ---------------------------------------------------------------------------
// The poller's "keep going?" decision.
// ---------------------------------------------------------------------------

describe('isTerminalStatus / shouldKeepPolling', () => {
  it('is terminal for exactly COMPLETED, REJECTED and CANCELED', () => {
    const terminal = ALL_STATUSES.filter(isTerminalStatus).sort()
    expect(terminal).toEqual(['CANCELED', 'COMPLETED', 'REJECTED'])
  })

  it('keeps polling on every non-terminal status while the tab is visible', () => {
    for (const status of ALL_STATUSES.filter((s) => !isTerminalStatus(s))) {
      expect(shouldKeepPolling(status, false), status).toBe(true)
    }
  })

  it('stops for a terminal status even though the tab is visible', () => {
    for (const status of ['COMPLETED', 'REJECTED', 'CANCELED'] as const) {
      expect(shouldKeepPolling(status, false), status).toBe(false)
    }
  })

  it('pauses for a hidden tab regardless of status — no point spending battery on it', () => {
    expect(shouldKeepPolling('NEW', true)).toBe(false)
    expect(shouldKeepPolling('READY', true)).toBe(false)
  })

  it('stays stopped for a terminal status even once the tab is visible again', () => {
    expect(shouldKeepPolling('COMPLETED', false)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The clear-cart-once decision.
// ---------------------------------------------------------------------------

describe('shouldClearCartOnArrival', () => {
  it('clears the first time any order reaches this page in this browser', () => {
    expect(shouldClearCartOnArrival('ord-1', null)).toBe(true)
  })

  it('is idempotent on reload — the same order does not clear a second time', () => {
    expect(shouldClearCartOnArrival('ord-1', 'ord-1')).toBe(false)
  })

  it('clears again for a second, different order reaching the page in the same tab', () => {
    expect(shouldClearCartOnArrival('ord-2', 'ord-1')).toBe(true)
  })
})

describe('clearedMarkerKey', () => {
  it('is namespaced per slug — the partition the cart itself is stored under', () => {
    expect(clearedMarkerKey('kashi')).not.toBe(clearedMarkerKey('other-restaurant'))
    expect(clearedMarkerKey('kashi')).toContain('kashi')
  })
})

// ---------------------------------------------------------------------------
// The quoted time, in a FIXED timezone — never the phone's.
// ---------------------------------------------------------------------------

describe('readyAtLabel', () => {
  it('renders a fixed instant in the LOCATION’s timezone, never the phone’s', () => {
    const at = new Date('2026-09-22T23:35:00Z')
    expect(readyAtLabel(at, 'America/New_York')).toBe('Ready around 7:35 PM')
    expect(readyAtLabel(at, 'America/Los_Angeles')).toBe('Ready around 4:35 PM')
    expect(readyAtLabel(at, 'UTC')).toBe('Ready around 11:35 PM')
  })

  it('carries a promise across a midnight the same way quoteLabel does', () => {
    expect(readyAtLabel(new Date('2026-09-22T23:55:00Z'), 'UTC')).toBe('Ready around 11:55 PM')
    expect(readyAtLabel(new Date('2026-09-23T00:15:00Z'), 'UTC')).toBe('Ready around 12:15 AM')
  })
})

// ---------------------------------------------------------------------------
// The markup.
// ---------------------------------------------------------------------------

describe('StatusView', () => {
  function render(over: Partial<Parameters<typeof StatusView>[0]> = {}): string {
    return renderToStaticMarkup(
      <StatusView
        location={KASHI}
        shortCode="K7M2"
        status="NEW"
        quotedReadyAt={null}
        {...over}
      />,
    )
  }

  it('shows the short code enormous, with the counter hint', () => {
    const markup = render()
    expect(markup).toMatch(/data-code="1"[^>]*>K7M2</)
    expect(markup).toMatch(/counter/i)
  })

  it('lights PLACED for a fresh order and leaves ACCEPTED, READY unlit', () => {
    const markup = render({ status: 'NEW' })
    expect(markup).toMatch(/data-step="PLACED"[^>]*data-active="1"/)
    expect(markup).not.toMatch(/data-step="ACCEPTED"[^>]*data-active="1"/)
    expect(markup).not.toMatch(/data-step="READY"[^>]*data-active="1"/)
  })

  it('lights ACCEPTED for both ACCEPTED and IN_KITCHEN', () => {
    for (const status of ['ACCEPTED', 'IN_KITCHEN'] as const) {
      const markup = render({ status })
      expect(markup, status).toMatch(/data-step="ACCEPTED"[^>]*data-active="1"/)
    }
  })

  it('shows the strip for PENDING_PAYMENT with nothing lit, and says so', () => {
    const markup = render({ status: 'PENDING_PAYMENT' })
    expect(markup).toMatch(/data-strip="1"/)
    // Scoped to an actual `<li>`, not a bare substring: `STATUS_CSS`'s own
    // `[data-active="1"]` selector otherwise makes this assertion pass for the
    // wrong reason — true because of the stylesheet, not because nothing is lit.
    expect(markup).not.toMatch(/<li[^>]*data-active="1"/)
    expect(markup).toMatch(/confirming payment/i)
  })

  it('shows the ready time in the location’s timezone when one is quoted', () => {
    const markup = render({ status: 'ACCEPTED', quotedReadyAt: '2026-09-22T23:35:00Z' })
    expect(markup).toContain('Ready around 7:35 PM')
  })

  it('shows no ready time when none is quoted yet', () => {
    const markup = render({ status: 'PENDING_PAYMENT', quotedReadyAt: null })
    expect(markup).not.toMatch(/data-ready="1"/)
  })

  it('drops the strip and gives REJECTED and CANCELED the phone as the next step', () => {
    for (const status of ['REJECTED', 'CANCELED'] as const) {
      const markup = render({ status })
      expect(markup, status).not.toMatch(/data-strip="1"/)
      expect(markup, status).toMatch(/data-call="1"/)
      expect(markup, status).toContain('(973) 555-0123')
      expect(markup, status).toContain(`tel:${KASHI.phoneE164}`)
    }
  })

  it('still offers the phone quietly on the happy path, for "something wrong"', () => {
    const markup = render({ status: 'READY' })
    expect(markup).toContain('(973) 555-0123')
  })
})
