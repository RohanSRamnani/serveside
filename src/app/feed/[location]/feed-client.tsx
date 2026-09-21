'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { formatCents } from '@/lib/money'
import type { FeedOrder, FeedPayload } from '@/domain/feed'
import { KITCHEN_STATUSES, type OrderStatus } from '@/domain/order-status'

/**
 * The kitchen board, on a tablet, wedged between a till and a pass.
 *
 * Everything here is shaped by where it lives rather than by taste. It is read from
 * about a metre away by someone holding a pan, so the type is enormous and the
 * contrast is fixed rather than following `prefers-color-scheme`. It is tapped with
 * a wet or gloved hand, so nothing is smaller than a thumb. It is the only thing
 * telling a kitchen an order exists, so it makes a noise until someone touches it.
 *
 * It polls; it does not hold a socket. A tablet sleeps, loses wifi and wakes up
 * somewhere else on the network, and a poll recovers from all three by itself while
 * a dropped socket fails silently — see the plan.
 */

/** Five seconds. A cook who has to wait longer than that starts refreshing the page. */
const POLL_MS = 5_000

/** What the Accept button offers when the kitchen is behind. Anything else is a phone call. */
const PREP_BUMPS = [5, 10, 15] as const

export type FeedClientProps = {
  locationSlug: string
  locationName: string
  /** The first paint, read on the server — a kitchen tablet never shows an empty board it has to wait out. */
  initial: FeedPayload
  /**
   * The floor of the board's window, fixed for the life of the page.
   *
   * **It must not advance between polls.** The change that matters between two polls
   * is usually an order that is *already* on the board moving to ACCEPTED or READY,
   * and a cursor that walked forward would stop asking about exactly those.
   */
  since?: string
}

// ---------------------------------------------------------------------------
// The decisions, pulled out of the component so they can be tested without a browser.
// ---------------------------------------------------------------------------

/**
 * The orders that are still shouting: NEW, and nobody has touched the screen since
 * they landed. Acknowledgement is per order id rather than a single "silenced" flag,
 * so silencing the board now does not silence the order that arrives in two minutes.
 */
export function unacknowledgedNew(orders: readonly FeedOrder[], acknowledged: ReadonlySet<string>): FeedOrder[] {
  return orders.filter((o) => o.status === 'NEW' && !acknowledged.has(o.id))
}

/** The buttons a card carries, which is exactly the moves the machine allows from here. */
export type FeedAction = { to: OrderStatus; label: string; tone: 'go' | 'stop' }

export function actionsFor(status: OrderStatus): FeedAction[] {
  switch (status) {
    // Accept is rendered on its own with the prep bumps beside it, so it is not here.
    case 'NEW': return [{ to: 'REJECTED', label: 'Reject', tone: 'stop' }]
    case 'ACCEPTED': return [{ to: 'READY', label: 'Ready', tone: 'go' }]
    case 'IN_KITCHEN': return [{ to: 'READY', label: 'Ready', tone: 'go' }]
    case 'READY': return [{ to: 'COMPLETED', label: 'Picked up', tone: 'go' }]
    default: return []
  }
}

/**
 * Folds a transition's answer back into the board: the card is replaced where it
 * stands, or removed if the move took it off the kitchen's plate entirely.
 *
 * Replacing in place rather than re-sorting matters — a card that jumped position
 * the instant it was accepted is a card the next tap lands on by accident.
 */
export function applyMoved(orders: readonly FeedOrder[], moved: FeedOrder): FeedOrder[] {
  // The same set the feed query filters on, imported rather than restated: a board
  // that decided for itself what "still cooking" means would disagree with the next
  // poll five seconds later, and the card would flicker back.
  const stillCooking = (KITCHEN_STATUSES as readonly OrderStatus[]).includes(moved.status)
  if (!stillCooking) return orders.filter((o) => o.id !== moved.id)
  return orders.map((o) => (o.id === moved.id ? moved : o))
}

/** Whole minutes between two instants, floored, never negative. Clocks disagree; a kitchen does not care. */
export function minutesBetween(fromIso: string, toIso: string): number {
  return Math.max(0, Math.floor((Date.parse(toIso) - Date.parse(fromIso)) / 60_000))
}

/** Past its promised time. The one thing on the card that has to be noticed from across a kitchen. */
export function isLate(order: FeedOrder, nowIso: string): boolean {
  return order.quotedReadyAt !== null && Date.parse(order.quotedReadyAt) < Date.parse(nowIso)
}

// ---------------------------------------------------------------------------

export default function FeedClient({ locationSlug, locationName, initial, since }: FeedClientProps) {
  const [payload, setPayload] = useState<FeedPayload>(initial)
  const [acknowledged, setAcknowledged] = useState<ReadonlySet<string>>(() => new Set())
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set())
  const [problem, setProblem] = useState<string | null>(null)
  const [soundUnlocked, setSoundUnlocked] = useState(false)

  const audioRef = useRef<HTMLAudioElement>(null)
  const unlockedRef = useRef(false)

  const shouting = useMemo(
    () => unacknowledgedNew(payload.orders, acknowledged),
    [payload.orders, acknowledged],
  )
  const wantsChime = shouting.length > 0
  // Read inside the play() promise below, which settles long after the render that
  // started it — by then `wantsChime` in that closure may be a lie. Written from an
  // effect rather than during render: a render can be thrown away and re-run.
  const wantsChimeRef = useRef(wantsChime)

  const feedUrl = useMemo(() => {
    const url = new URL('/api/feed', 'http://feed.local')
    url.searchParams.set('location', locationSlug)
    if (since) url.searchParams.set('since', since)
    return `${url.pathname}${url.search}`
  }, [locationSlug, since])

  // ---- The poll. One interval for the life of the page. ----
  useEffect(() => {
    const controller = new AbortController()
    let stopped = false

    async function poll() {
      try {
        const res = await fetch(feedUrl, { signal: controller.signal, cache: 'no-store' })
        if (!res.ok) throw new Error(`feed responded ${res.status}`)
        const next: FeedPayload = await res.json()
        if (!stopped) {
          setPayload(next)
          setProblem(null)
        }
      } catch {
        // Wifi in a kitchen drops. The board keeps showing what it last knew and says
        // so, rather than blanking — a blank board reads as "no orders", which is the
        // one wrong answer it could give.
        if (!stopped) setProblem('NO CONNECTION — showing the last board we had')
      }
    }

    const timer = setInterval(poll, POLL_MS)
    return () => {
      stopped = true
      clearInterval(timer)
      controller.abort()
    }
  }, [feedUrl])

  // ---- The chime. ----
  useEffect(() => {
    wantsChimeRef.current = wantsChime
    const el = audioRef.current
    if (!el) return
    if (wantsChime && soundUnlocked) {
      void el.play().catch(() => {
        // The browser refused after all — fall back to the "tap for sound" banner
        // rather than pretending the kitchen is being told.
        unlockedRef.current = false
        setSoundUnlocked(false)
      })
    } else {
      el.pause()
      el.currentTime = 0
    }
  }, [wantsChime, soundUnlocked])

  /**
   * The first tap does two jobs, and both of them have to happen inside the gesture.
   *
   * Silencing is the obvious one. The other is autoplay: a browser will not start
   * audio a user has not asked for, and on iPadOS — which is what a kitchen tablet
   * usually is — the permission attaches to the **element**, granted only by a
   * `play()` that a gesture began. So the first tap plays it once, then stops it
   * again if by then there is nothing left to shout about.
   */
  const acknowledgeEverything = useCallback(() => {
    const el = audioRef.current
    if (el && !unlockedRef.current) {
      unlockedRef.current = true
      void el.play().then(() => {
        if (!wantsChimeRef.current) {
          el.pause()
          el.currentTime = 0
        }
      }).catch(() => { unlockedRef.current = false })
      setSoundUnlocked(true)
    }
    setAcknowledged((prev) => {
      // Every tap anywhere on the board lands here, so it returns the set it was given
      // when nothing changed — a fresh Set each time would re-render the whole board
      // on every touch of every button.
      const fresh = payload.orders.filter((o) => o.status === 'NEW' && !prev.has(o.id))
      if (fresh.length === 0) return prev
      const next = new Set(prev)
      for (const order of fresh) next.add(order.id)
      return next
    })
  }, [payload.orders])

  const move = useCallback(async (orderId: string, to: OrderStatus, prepBumpMinutes?: number) => {
    setPending((prev) => new Set(prev).add(orderId))
    try {
      const res = await fetch(
        `/api/orders/${orderId}/transition?location=${encodeURIComponent(locationSlug)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(prepBumpMinutes === undefined ? { to } : { to, prepBumpMinutes }),
        },
      )
      if (!res.ok) {
        // Most likely a double-tap racing the first tap's answer, or another tablet
        // in the same kitchen having already moved the card — both come back 422
        // `illegal_transition`. The next poll is five seconds away and carries the
        // truth, so nothing is invented here and nothing is rolled back.
        setProblem('THAT TAP DIDN’T STICK — the board refreshes in a few seconds')
        return
      }
      const { order }: { order: FeedOrder } = await res.json()
      setPayload((prev) => ({ ...prev, orders: applyMoved(prev.orders, order) }))
      setProblem(null)
    } catch {
      setProblem('NO CONNECTION — that tap did not reach the kitchen')
    } finally {
      setPending((prev) => {
        const next = new Set(prev)
        next.delete(orderId)
        return next
      })
    }
  }, [locationSlug])

  return (
    <div style={styles.page} onPointerDown={acknowledgeEverything}>
      <audio ref={audioRef} src="/chime.wav" loop preload="auto" />

      <header style={styles.header}>
        <h1 style={styles.title}>{locationName}</h1>
        <div style={styles.headerRight}>
          {problem ? <span style={styles.problem}>{problem}</span> : null}
          {wantsChime && !soundUnlocked
            ? <span style={styles.soundHint}>TAP ANYWHERE FOR SOUND</span>
            : null}
          <span style={styles.count}>{payload.orders.length} open</span>
        </div>
      </header>

      {payload.orders.length === 0
        ? <p style={styles.empty}>No open orders.</p>
        : (
          <div style={styles.board}>
            {payload.orders.map((order) => (
              <OrderCard
                key={order.id}
                order={order}
                now={payload.now}
                busy={pending.has(order.id)}
                onMove={move}
              />
            ))}
          </div>
        )}
    </div>
  )
}

function OrderCard({ order, now, busy, onMove }: {
  order: FeedOrder
  now: string
  busy: boolean
  onMove: (orderId: string, to: OrderStatus, prepBumpMinutes?: number) => void
}) {
  const waiting = minutesBetween(order.createdAt, now)
  const late = isLate(order, now)

  return (
    <section style={{ ...styles.card, ...(order.status === 'NEW' ? styles.cardNew : null) }}>
      <div style={styles.cardTop}>
        <span style={styles.code}>{order.shortCode}</span>
        <span style={styles.status}>{order.status.replace('_', ' ')}</span>
        <span style={late ? styles.waitLate : styles.wait}>{waiting} min</span>
      </div>

      <div style={styles.who}>
        {order.contactName} · {order.contactPhone} · {order.fulfillment}
        {order.paymentStatus === 'PAY_ON_PICKUP' ? ' · TAKE PAYMENT' : ''}
      </div>

      <ul style={styles.lines}>
        {order.items.map((item) => (
          <li key={item.id} style={styles.line}>
            <span style={styles.qty}>{item.qty}×</span>
            <span>
              <span style={styles.dish}>{item.nameSnapshot}</span>
              {item.modifiers.length > 0
                ? <span style={styles.mods}>{item.modifiers.map((m) => m.nameSnapshot).join(' · ')}</span>
                : null}
              {item.notes ? <span style={styles.lineNote}>“{item.notes}”</span> : null}
            </span>
          </li>
        ))}
      </ul>

      {order.notes ? <p style={styles.orderNote}>NOTE: {order.notes}</p> : null}

      <div style={styles.money}>
        {`$${formatCents(order.totalCents)}`}
        {order.quotedReadyAt
          ? <span style={styles.promised}> · promised {timeOfDay(order.quotedReadyAt)}</span>
          : null}
      </div>

      <div style={styles.buttons}>
        {order.status === 'NEW'
          ? (
            <>
              <button
                type="button"
                disabled={busy}
                style={{ ...styles.button, ...styles.accept }}
                onClick={() => onMove(order.id, 'ACCEPTED')}
              >
                Accept
              </button>
              {PREP_BUMPS.map((minutes) => (
                <button
                  key={minutes}
                  type="button"
                  disabled={busy}
                  style={{ ...styles.button, ...styles.bump }}
                  onClick={() => onMove(order.id, 'ACCEPTED', minutes)}
                >
                  +{minutes} min
                </button>
              ))}
            </>
          )
          : null}
        {actionsFor(order.status).map((action) => (
          <button
            key={action.to}
            type="button"
            disabled={busy}
            style={{ ...styles.button, ...(action.tone === 'go' ? styles.accept : styles.reject) }}
            onClick={() => onMove(order.id, action.to)}
          >
            {action.label}
          </button>
        ))}
      </div>
    </section>
  )
}

/** 24-hour wall clock in the browser's own zone — which, on the counter tablet, is the restaurant's. */
function timeOfDay(iso: string): string {
  const at = new Date(iso)
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

/**
 * Inline rather than a stylesheet: this page is one screen that exists in one place,
 * and every number in here is a legibility decision (48px codes, 64px tap targets)
 * rather than a theme. Fixed dark, not `prefers-color-scheme` — a board that inverts
 * itself at dusk because the tablet changed its mind is a board nobody trusts.
 */
const styles = {
  page: {
    minHeight: '100vh',
    width: '100%',
    background: '#111',
    color: '#fff',
    padding: '16px',
    fontFamily: 'system-ui, sans-serif',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: '16px',
    flexWrap: 'wrap',
    marginBottom: '16px',
  },
  title: { fontSize: '32px', fontWeight: 700 },
  headerRight: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' },
  problem: { background: '#a00', padding: '8px 12px', fontSize: '20px', fontWeight: 700 },
  soundHint: { background: '#fc0', color: '#000', padding: '8px 12px', fontSize: '20px', fontWeight: 700 },
  count: { fontSize: '24px', color: '#aaa' },
  empty: { fontSize: '28px', color: '#aaa', padding: '32px 0' },
  board: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))',
    gap: '16px',
  },
  card: { background: '#1e1e1e', border: '3px solid #333', padding: '16px' },
  cardNew: { border: '3px solid #fc0' },
  cardTop: { display: 'flex', alignItems: 'baseline', gap: '16px', flexWrap: 'wrap' },
  code: { fontSize: '48px', fontWeight: 800, letterSpacing: '2px' },
  status: { fontSize: '20px', color: '#aaa', textTransform: 'uppercase' },
  wait: { marginLeft: 'auto', fontSize: '28px', fontWeight: 700 },
  waitLate: { marginLeft: 'auto', fontSize: '28px', fontWeight: 800, color: '#ff5252' },
  who: { fontSize: '20px', color: '#ccc', margin: '8px 0 12px' },
  lines: { listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '12px' },
  line: { display: 'flex', gap: '12px', fontSize: '26px', lineHeight: 1.25 },
  qty: { fontWeight: 800, minWidth: '56px' },
  dish: { display: 'block', fontWeight: 700 },
  mods: { display: 'block', fontSize: '22px', color: '#ffd166' },
  lineNote: { display: 'block', fontSize: '22px', color: '#8ecae6', fontStyle: 'italic' },
  orderNote: { marginTop: '12px', fontSize: '24px', fontWeight: 700, color: '#8ecae6' },
  money: { marginTop: '12px', fontSize: '22px', color: '#aaa' },
  promised: { color: '#aaa' },
  buttons: { display: 'flex', flexWrap: 'wrap', gap: '12px', marginTop: '16px' },
  button: {
    flex: '1 1 auto',
    minHeight: '64px',
    minWidth: '110px',
    fontSize: '24px',
    fontWeight: 800,
    border: 'none',
    color: '#000',
    cursor: 'pointer',
  },
  accept: { background: '#2ecc71' },
  bump: { background: '#f0c419' },
  reject: { background: '#ff5252' },
} satisfies Record<string, CSSProperties>
