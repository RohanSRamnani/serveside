import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { drizzle } from 'drizzle-orm/neon-serverless'
import { Pool, neonConfig } from '@neondatabase/serverless'
import * as schema from '@/db/schema'
import type { MenuSnapshotPayload, SnapshotItem } from '@/db/schema'
import { seedKashi, KASHI, type SeedDb } from './seed-kashi'

/**
 * `npm run spine:proof` is the one artefact of this plan a person runs by hand, so the
 * thing worth testing is that it still proves something: an order placed through the
 * real `createOrder`, the real fan-out, and a real rendered ticket waiting in the queue
 * a printer polls.
 *
 * It runs against a **Kashi seeded with the always-open grid**, which is exactly what
 * that grid is for: `createOrder` asks the real `isOpenAt(now)`, so with Kashi's real
 * hours this file would only be green between 11am and 10pm New York time.
 *
 * `sendSms` is mocked and nothing else is. The fan-out's SMS leg is a real HTTP call
 * to Twilio otherwise — money, and a text to a real restaurant, from CI.
 */
const { sendSms } = vi.hoisted(() => ({ sendSms: vi.fn() }))
vi.mock('@/lib/sms', () => ({ sendSms }))

const {
  runProof, chooseProofLines, fanOutOutcome, awaitQueuedTicket,
} = await import('./place-test-order')

if (!neonConfig.webSocketConstructor && typeof globalThis.WebSocket !== 'undefined') {
  neonConfig.webSocketConstructor = globalThis.WebSocket as unknown as typeof neonConfig.webSocketConstructor
}

let pool: Pool
let owner: SeedDb
let locationId: string

beforeAll(async () => {
  pool = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL! })
  owner = drizzle(pool, { schema })
  const summary = await seedKashi(owner, { hours: 'always-open' })
  locationId = summary.locationId
}, 60_000)

afterAll(async () => {
  await pool.end()
})

beforeEach(() => {
  sendSms.mockReset()
  sendSms.mockResolvedValue(undefined)
  // The fan-out's SMS carries a link to the kitchen feed; `.env.test` has no FEED_URL,
  // deliberately, so it is stubbed per test rather than added to the file.
  vi.stubEnv('FEED_URL', 'https://serveside.test/feed')
})

/** A snapshot payload shaped like a real one, for the pure picker. */
function snapshot(items: SnapshotItem[]): MenuSnapshotPayload {
  return { menuId: 'menu-1', categories: [{ id: 'cat-1', name: 'Mains', items }] }
}

function item(over: Partial<SnapshotItem> & { id: string; name: string }): SnapshotItem {
  return { basePriceCents: 1000, is86d: false, modifierGroups: [], ...over }
}

describe('chooseProofLines', () => {
  it('prefers a dish with a mandatory group, and satisfies it exactly', () => {
    const chosen = chooseProofLines(snapshot([
      item({ id: 'a1b2c3d4-0000-4000-8000-000000000001', name: 'Naan' }),
      item({
        id: 'a1b2c3d4-0000-4000-8000-000000000002',
        name: 'Butter Chicken',
        modifierGroups: [{
          id: 'g1', name: 'Spice Level', minSelect: 1, maxSelect: 1, required: true,
          options: [
            { id: 'o1', name: 'Mild', priceDeltaCents: 0, is86d: false },
            { id: 'o2', name: 'Hot', priceDeltaCents: 0, is86d: false },
          ],
        }],
      }),
    ]))

    // The mandatory dish leads, with exactly `minSelect` options on it — one more
    // would be a ModifierSelectionError, one fewer likewise.
    expect(chosen.items[0].menuItemId).toBe('a1b2c3d4-0000-4000-8000-000000000002')
    expect(chosen.items[0].modifierOptionIds).toEqual(['o1'])
    expect(chosen.items[1].menuItemId).toBe('a1b2c3d4-0000-4000-8000-000000000001')
    expect(chosen.description[0]).toBe('2× Butter Chicken (Mild)')
  })

  it('picks nothing from an optional group', () => {
    const chosen = chooseProofLines(snapshot([
      item({
        id: 'a1b2c3d4-0000-4000-8000-000000000003',
        name: 'Dal',
        modifierGroups: [{
          id: 'g2', name: 'Add Naan', minSelect: 0, maxSelect: 2, required: false,
          options: [{ id: 'o3', name: 'Garlic Naan', priceDeltaCents: 700, is86d: false }],
        }],
      }),
    ]))
    expect(chosen.items[0].modifierOptionIds).toEqual([])
  })

  it('skips a dish whose mandatory choices are all 86\'d, and one that is 86\'d itself', () => {
    const chosen = chooseProofLines(snapshot([
      item({ id: 'a1b2c3d4-0000-4000-8000-000000000004', name: 'Sold out', is86d: true }),
      item({
        id: 'a1b2c3d4-0000-4000-8000-000000000005',
        name: 'Unsatisfiable',
        modifierGroups: [{
          id: 'g3', name: 'Spice Level', minSelect: 1, maxSelect: 1, required: true,
          options: [{ id: 'o4', name: 'Hot', priceDeltaCents: 0, is86d: true }],
        }],
      }),
      item({ id: 'a1b2c3d4-0000-4000-8000-000000000006', name: 'Naan' }),
    ]))
    expect(chosen.items).toHaveLength(1)
    expect(chosen.items[0].menuItemId).toBe('a1b2c3d4-0000-4000-8000-000000000006')
  })

  it('says so when nothing on the menu can be ordered', () => {
    expect(() => chooseProofLines(snapshot([item({ id: 'x', name: 'Sold out', is86d: true })])))
      .toThrow(/No orderable item/)
  })
})

describe('fanOutOutcome', () => {
  it('survives an SMS-only failure — a dev env file has no Twilio credentials', () => {
    const out = fanOutOutcome(new Error('order abc fan-out incomplete — sms-owner: Missing required env var: TWILIO_ACCOUNT_SID'))
    expect(out.fatal).toBe(false)
  })

  it('is fatal when the print leg is named, even alongside the SMS leg', () => {
    expect(fanOutOutcome(new Error('order abc fan-out incomplete — queue-print-job: db is down')).fatal).toBe(true)
    expect(fanOutOutcome(new Error('order abc fan-out incomplete — queue-print-job: db is down; sms-owner: twilio is down')).fatal).toBe(true)
  })

  it('is fatal for anything that is not a fan-out failure at all', () => {
    expect(fanOutOutcome(new Error('connection terminated')).fatal).toBe(true)
    expect(fanOutOutcome('a string').fatal).toBe(true)
  })
})

describe('runProof, against a freshly seeded Kashi', () => {
  it('places an order, fans out, and leaves a rendered ticket in the print queue', async () => {
    const result = await runProof(locationId)

    // Pay-on-pickup reaches the kitchen inside createOrder — no Stripe in the path.
    expect(result.order.status).toBe('NEW')
    expect(result.warning).toBeUndefined()

    // The ticket is the artefact, and it is the stored payload rather than a fresh
    // render: this is what a printer would collect.
    expect(result.ticket).toContain(`*** ${result.order.shortCode} ***`)
    expect(result.ticket).toContain('PICKUP')
    expect(result.ticket).toContain('PAY AT PICKUP')
    expect(result.ticket).toContain('Spine Proof')
    expect(result.ticket).toContain('TOTAL')

    // Every line the picker chose, printed — asserted word by word rather than as one
    // string. The paper is 32 columns and the money column is fixed, so a long dish
    // name is *supposed* to wrap around it: "1× Sweet Chilli    16.00" then an
    // indented "Cauliflower". That is the renderer working, not a defect.
    const flattened = result.ticket.replace(/\s+/g, ' ')
    for (const line of result.description) {
      const [, qty, name, modifiers] = line.match(/^(\d+)× ([^(]+)(?:\((.*)\))?/) ?? []
      const words = name!.trim().split(' ')
      expect(flattened).toContain(`${qty}× ${words[0]}`)
      for (const word of words) expect(flattened, word).toContain(word)
      for (const modifier of modifiers?.split(', ') ?? []) expect(flattened, modifier).toContain(modifier)
    }

    // The owner's phone is the other leg, and it is independent of the ticket.
    expect(sendSms).toHaveBeenCalledTimes(1)
    expect(sendSms.mock.calls[0][0]).toBe(KASHI.location.phoneE164)
    expect(sendSms.mock.calls[0][1]).toContain(result.order.shortCode)

    // And the queued job really is findable the way a printer finds it.
    const job = await awaitQueuedTicket(locationId, result.order.orderId, 2_000)
    expect(job.id).toBe(result.printJobId)
  }, 60_000)

  it('still proves the ticket when the SMS leg is dead', async () => {
    sendSms.mockRejectedValue(new Error('twilio is down'))

    const result = await runProof(locationId)

    expect(result.warning).toContain('sms-owner: twilio is down')
    expect(result.warning).not.toContain('queue-print-job')
    expect(result.ticket).toContain(`*** ${result.order.shortCode} ***`)
  }, 60_000)
})
