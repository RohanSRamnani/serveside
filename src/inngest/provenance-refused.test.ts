import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { GetStepTools } from 'inngest'
import { inngest as inngestClient, PROVENANCE_REFUSED } from '@/inngest/client'

/**
 * The alarm on the refusals the Stripe webhook makes but nobody hears.
 *
 * Both of them — money from another connected account, and an amount that is not what
 * the order costs — are fail-closed checks against something being *attempted*. The
 * refusal protects the restaurant; this is what makes it a control somebody acts on
 * rather than a `console.error` in a serverless log.
 *
 * No database: the whole job is one message, and the ids in it are already checked by
 * the caller that sent them.
 */
const { sendSms } = vi.hoisted(() => ({ sendSms: vi.fn() }))
vi.mock('@/lib/sms', () => ({ sendSms }))

const { provenanceRefused, alertProvenanceRefused } = await import('./provenance-refused')

const OPS_PHONE = '+15550007777'
const ORDER_ID = '11111111-1111-4111-8111-111111111111'
const LOCATION_ID = '22222222-2222-4222-8222-222222222222'

/** A `step` that simply runs the work — see `order-created.test.ts` for why. */
const step = {
  run: (_id: string, fn: () => Promise<unknown>) => fn(),
} as unknown as GetStepTools<typeof inngestClient>

beforeEach(() => {
  sendSms.mockReset()
  sendSms.mockResolvedValue(undefined)
  vi.stubEnv('OPS_ALERT_E164', OPS_PHONE)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('the provenance-refused alarm', () => {
  it('listens for the event the webhook sends', () => {
    // Read off the function's own options rather than restated: a typo'd event name
    // compiles, serves, and is delivered nothing, forever.
    expect(provenanceRefused.opts.triggers).toEqual([{ event: PROVENANCE_REFUSED }])
  })

  it('texts ops the order to go and look at', async () => {
    const result = await alertProvenanceRefused(
      { orderId: ORDER_ID, locationId: LOCATION_ID, reason: 'account_mismatch' },
      step,
    )

    // **Ops only, never the restaurant.** The owner can do nothing about this, and if
    // the cause is our own misconfiguration instead — a Connect webhook on the wrong
    // account refuses every genuine payment — "a payment was refused" is alarming and
    // useless in one sentence. The id is what gets pasted into the Stripe dashboard.
    expect(sendSms).toHaveBeenCalledTimes(1)
    expect(sendSms).toHaveBeenCalledWith(
      OPS_PHONE,
      `Payment provenance refused for order ${ORDER_ID} — investigate`,
    )
    expect(result).toEqual({ orderId: ORDER_ID, reason: 'account_mismatch' })
  })

  it('reports the amount refusal the same way', async () => {
    await alertProvenanceRefused(
      { orderId: ORDER_ID, locationId: LOCATION_ID, reason: 'amount_mismatch' },
      step,
    )
    expect(sendSms).toHaveBeenCalledTimes(1)
  })

  it('refuses an event that does not name an order, rather than texting about nothing', async () => {
    // The payload arrives over HTTP from the orchestrator, so it is input. Waking
    // somebody at 2am to investigate `undefined` is worse than not waking them.
    for (const data of [
      undefined,
      { orderId: 'not-a-uuid', locationId: LOCATION_ID, reason: 'account_mismatch' },
      { orderId: ORDER_ID, locationId: 'not-a-uuid', reason: 'account_mismatch' },
      { orderId: ORDER_ID, locationId: LOCATION_ID, reason: 'because' },
    ]) {
      await expect(alertProvenanceRefused(data, step), JSON.stringify(data))
        .rejects.toThrow(/payments\/provenance-refused/)
    }
    expect(sendSms).not.toHaveBeenCalled()
  })
})
