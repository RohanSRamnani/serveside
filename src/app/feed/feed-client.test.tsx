import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { FeedOrder, FeedPayload } from '@/domain/feed'
import type { OrderStatus } from '@/domain/order-status'
import FeedClient, {
  actionsFor, applyMoved, isLate, minutesBetween, unacknowledgedNew,
} from './[location]/feed-client'

/**
 * What can honestly be tested about a kitchen tablet without a kitchen tablet.
 *
 * Two halves. The decisions — which orders are still shouting, which buttons a card
 * carries, what a transition does to the board — are ordinary functions and are
 * tested as such. The card itself is rendered to static markup, which is enough to
 * prove the things that make an order cookable: the dish, its modifiers, both kinds
 * of note, and tap targets a gloved thumb can actually hit.
 *
 * **What this does not cover, and what does:** the five-second poll, the chime's
 * autoplay unlock, and anything that depends on layout or on a real gesture. None of
 * those exist outside a browser. They are the manual check in the task brief — open
 * `/feed/<slug>`, watch a seeded order appear within five seconds, hear it, tap once,
 * hear it stop.
 */

const NOW = '2026-09-21T18:30:00.000Z'

function order(over: Partial<FeedOrder> = {}): FeedOrder {
  return {
    id: 'ord_1',
    shortCode: 'K7M2',
    status: 'NEW',
    fulfillment: 'pickup',
    paymentStatus: 'PAID',
    channel: 'web',
    contactName: 'Rohan R',
    contactPhone: '+15551234567',
    notes: 'no cilantro',
    totalCents: 4524,
    createdAt: '2026-09-21T18:23:00.000Z',
    quotedReadyAt: null,
    scheduledFor: null,
    items: [{
      id: 'itm_1',
      nameSnapshot: 'Butter Chicken',
      qty: 2,
      notes: 'extra crispy',
      modifiers: [{ nameSnapshot: 'Hot', priceDeltaCents: 50 }],
    }],
    ...over,
  }
}

function payload(orders: FeedOrder[]): FeedPayload {
  return { orders, now: NOW }
}

describe('what the board is still shouting about', () => {
  it('counts a NEW order nobody has touched, and stops counting it once tapped', () => {
    const fresh = order({ id: 'a' })
    const seen = order({ id: 'b' })
    expect(unacknowledgedNew([fresh, seen], new Set(['b']))).toEqual([fresh])
  })

  it('never shouts about an order that has already been accepted', () => {
    expect(unacknowledgedNew([order({ status: 'ACCEPTED' })], new Set())).toEqual([])
  })

  it('shouts again for the next order, having been silenced for this one', () => {
    // The whole reason acknowledgement is per order id rather than one "silenced"
    // flag: silencing the board at 19:00 must not silence the order that lands at 19:02.
    const acknowledged = new Set(['a'])
    expect(unacknowledgedNew([order({ id: 'a' }), order({ id: 'b' })], acknowledged).map((o) => o.id))
      .toEqual(['b'])
  })
})

describe('the buttons a card carries', () => {
  it('offers exactly the next move, and Accept is rendered separately with its bumps', () => {
    // Accept is absent from this list on purpose — it comes with +5/+10/+15 beside it
    // and is laid out by the card itself.
    expect(actionsFor('NEW')).toEqual([{ to: 'REJECTED', label: 'Reject', tone: 'stop' }])
    expect(actionsFor('ACCEPTED').map((a) => a.to)).toEqual(['READY'])
    expect(actionsFor('IN_KITCHEN').map((a) => a.to)).toEqual(['READY'])
    expect(actionsFor('READY').map((a) => a.to)).toEqual(['COMPLETED'])
  })

  it('offers nothing at all once an order is done with', () => {
    const terminal: OrderStatus[] = ['COMPLETED', 'REJECTED', 'CANCELED', 'PENDING_PAYMENT']
    for (const status of terminal) expect(actionsFor(status), status).toEqual([])
  })
})

describe('folding a transition back into the board', () => {
  it('replaces the card where it stands rather than re-sorting around it', () => {
    // A card that jumped position the instant it was accepted is a card the next tap
    // lands on by accident — which in a kitchen means rejecting somebody's dinner.
    const first = order({ id: 'a' })
    const second = order({ id: 'b' })
    const moved = { ...second, status: 'ACCEPTED' as const }
    expect(applyMoved([first, second], moved)).toEqual([first, moved])
  })

  it('takes the card off the board when the kitchen is finished with it', () => {
    const kept = order({ id: 'a' })
    for (const status of ['COMPLETED', 'REJECTED', 'CANCELED'] as const) {
      const gone = { ...order({ id: 'b' }), status }
      expect(applyMoved([kept, order({ id: 'b' })], gone), status).toEqual([kept])
    }
  })
})

describe('how long an order has been waiting', () => {
  it('counts whole minutes against the server’s clock, not the tablet’s', () => {
    expect(minutesBetween('2026-09-21T18:23:00.000Z', NOW)).toBe(7)
  })

  it('never counts backwards when the two clocks disagree', () => {
    expect(minutesBetween('2026-09-21T18:31:00.000Z', NOW)).toBe(0)
  })

  it('calls an order late only once its promised time has actually passed', () => {
    expect(isLate(order({ quotedReadyAt: '2026-09-21T18:29:00.000Z' }), NOW)).toBe(true)
    expect(isLate(order({ quotedReadyAt: '2026-09-21T18:45:00.000Z' }), NOW)).toBe(false)
    // Never accepted, so nothing was promised and nothing can be late.
    expect(isLate(order(), NOW)).toBe(false)
  })
})

describe('the card itself', () => {
  const markup = renderToStaticMarkup(
    <FeedClient
      locationSlug="main"
      locationName="Kashi"
      initial={payload([order()])}
      since="2026-09-21T06:30:00.000Z"
    />,
  )

  it('prints everything a cook has to read to make the right dish', () => {
    expect(markup).toContain('K7M2')
    expect(markup).toContain('Butter Chicken')
    // The modifier and the line note are the difference between this dish and a
    // different dish. Losing either is silent and reaches a customer.
    expect(markup).toContain('Hot')
    expect(markup).toContain('extra crispy')
    expect(markup).toContain('no cilantro')
    // Phone, because a kitchen chases a no-show pickup with it.
    expect(markup).toContain('+15551234567')
    expect(markup).toContain('2') // the quantity
  })

  it('carries Accept, all three prep bumps, and Reject', () => {
    for (const label of ['Accept', '+5 min', '+10 min', '+15 min', 'Reject']) {
      expect(markup, label).toContain(label)
    }
  })

  it('keeps the tap targets thumb-sized and the order code readable across a kitchen', () => {
    // The one requirement in the brief that is not negotiable — "ugly is fine, small
    // buttons are not" — pinned to a number so a later tidy-up cannot quietly shrink it.
    expect(markup).toContain('min-height:64px')
    expect(markup).toContain('font-size:48px')
  })

  it('ships the chime, looping, ready before an order needs it', () => {
    // `preload` matters: a tablet that starts fetching a 24KB wav at the moment the
    // first order lands announces it late, or not at all on bad wifi.
    expect(markup).toMatch(/<audio[^>]*src="\/chime\.wav"/)
    expect(markup).toMatch(/<audio[^>]*loop/)
    expect(markup).toMatch(/<audio[^>]*preload="auto"/)
  })

  it('tells the counter when money still has to be taken', () => {
    // A pay-at-pickup order handed over without collecting is food given away, and
    // nothing else on the card distinguishes it from one already paid for.
    const cash = renderToStaticMarkup(
      <FeedClient
        locationSlug="main"
        locationName="Kashi"
        initial={payload([order({ paymentStatus: 'PAY_ON_PICKUP' })])}
      />,
    )
    expect(cash).toContain('TAKE PAYMENT')
    expect(cash).toContain('$45.24')
    expect(markup).not.toContain('TAKE PAYMENT')
  })

  it('says so plainly when there is nothing to cook', () => {
    const empty = renderToStaticMarkup(
      <FeedClient locationSlug="main" locationName="Kashi" initial={payload([])} />,
    )
    expect(empty).toContain('No open orders')
  })
})
