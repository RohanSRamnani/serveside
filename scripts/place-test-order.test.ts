import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest'
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
 * `sendSms` is mocked and nothing else is — and the mock is also an **assertion**:
 * `runProof` must never reach it, because the number the fan-out texts is a real
 * restaurant's. The interlock that stops it is `proofStep`, and the test below sets
 * working-looking Twilio credentials precisely so that a broken interlock would send.
 */
const { sendSms } = vi.hoisted(() => ({ sendSms: vi.fn() }))
vi.mock('@/lib/sms', () => ({ sendSms }))

const {
  runProof, chooseProofLines, awaitQueuedTicket,
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
  // Stubbed even though the SMS leg never runs here: if the interlock ever broke, the
  // leg would otherwise die on a missing `FEED_URL` (`.env.test` deliberately has
  // none) and the failure would read as an env problem instead of "it texted someone".
  vi.stubEnv('FEED_URL', 'https://serveside.test/feed')
})

afterEach(() => {
  vi.unstubAllEnvs()
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

describe('runProof, against a freshly seeded Kashi', () => {
  it('places an order, fans out, and leaves a rendered ticket in the print queue', async () => {
    const result = await runProof(locationId)

    // Pay-on-pickup reaches the kitchen inside createOrder — no Stripe in the path.
    expect(result.order.status).toBe('NEW')

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

    // The other leg is skipped, reported as skipped, and never reaches Twilio.
    expect(result.skippedSteps).toEqual(['sms-owner'])
    expect(sendSms).not.toHaveBeenCalled()

    // And the queued job really is findable the way a printer finds it.
    const job = await awaitQueuedTicket(locationId, result.order.orderId, 2_000)
    expect(job.id).toBe(result.printJobId)
  }, 60_000)

  it('never texts the restaurant, even with working Twilio credentials set', async () => {
    // The failure this pins is not hypothetical: `locations.phone_e164` is Kashi's
    // real number, and the day credentials land in `.env.local` a proof that ran the
    // SMS leg would text an actual kitchen about a fake order, silently, on every run.
    // Credentials are set here so that only the interlock in `proofStep` is left
    // standing between this test and a sent message.
    vi.stubEnv('TWILIO_ACCOUNT_SID', 'AC_proof_must_not_reach_twilio')
    vi.stubEnv('TWILIO_AUTH_TOKEN', 'token_proof_must_not_reach_twilio')
    vi.stubEnv('TWILIO_FROM_E164', '+15550000000')

    const result = await runProof(locationId)

    expect(sendSms).not.toHaveBeenCalled()
    expect(result.skippedSteps).toContain('sms-owner')
    // Deleting the skip in `proofStep` fails the line above and this one still passes,
    // which is the point: the ticket is the proof and it does not depend on the text.
    expect(result.ticket).toContain(`*** ${result.order.shortCode} ***`)
    expect(KASHI.location.phoneE164).toBe('+19179090243')
  }, 60_000)
})
