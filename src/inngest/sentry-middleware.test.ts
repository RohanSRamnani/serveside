import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * The bridge from a failed Inngest run to a Sentry event.
 *
 * Inngest catches whatever a function throws and reports it to the orchestrator, so it
 * never reaches Next's `onRequestError`: without this, a fan-out that failed for good
 * is a red run in a dashboard nobody has open. **Final attempts only** — Inngest retries
 * a failed run, and an event per attempt would be four events for one failure, and an
 * event for a failure its own retry then fixed.
 *
 * **And flushed before the hook returns.** Inngest awaits `onRunError` before it answers
 * the orchestrator, and the SDK does not flush on its own here — so awaiting the flush is
 * what gets the event out before the function can be suspended.
 */
const { captureException, flush, getClient } = vi.hoisted(() => ({
  captureException: vi.fn(),
  flush: vi.fn(),
  getClient: vi.fn(),
}))
vi.mock('@sentry/nextjs', () => ({ captureException, flush, getClient }))

const { SentryMiddleware } = await import('./sentry-middleware')
const { inngest } = await import('./client')
const { SENTRY_FLUSH_MS } = await import('@/lib/sentry-config')

const fn = { id: () => 'serveside-order-created-fan-out' }

function hook() {
  return new SentryMiddleware({ client: inngest })
}

beforeEach(() => {
  captureException.mockReset()
  flush.mockReset()
  flush.mockResolvedValue(true)
  getClient.mockReset()
  getClient.mockReturnValue({})
})

describe('SentryMiddleware', () => {
  it('captures a run that has failed for good, tagged with the function', async () => {
    const error = new Error('order ord-1 fan-out incomplete — sms-owner: twilio is down')

    await hook().onRunError!({ error, fn, isFinalAttempt: true, ctx: {} } as never)

    expect(captureException).toHaveBeenCalledTimes(1)
    expect(captureException).toHaveBeenCalledWith(error, {
      tags: { inngest_function: 'serveside-order-created-fan-out' },
    })
  })

  it('does not return until the event has been flushed', async () => {
    let finishFlush: (sent: boolean) => void = () => {}
    flush.mockImplementation(() => new Promise<boolean>((resolve) => { finishFlush = resolve }))

    let returned = false
    const running = Promise.resolve(hook().onRunError!({
      error: new Error('x'), fn, isFinalAttempt: true, ctx: {},
    } as never)).then(() => { returned = true })

    await vi.waitFor(() => expect(flush).toHaveBeenCalledWith(SENTRY_FLUSH_MS))
    await Promise.resolve()
    expect(returned).toBe(false)

    finishFlush(true)
    await running
    expect(returned).toBe(true)
  })

  it('stays quiet about an attempt Inngest is still going to retry', async () => {
    await hook().onRunError!({ error: new Error('blip'), fn, isFinalAttempt: false, ctx: {} } as never)
    expect(captureException).not.toHaveBeenCalled()
    expect(flush).not.toHaveBeenCalled()
  })

  it('does nothing at all when there is no DSN', async () => {
    getClient.mockReturnValue(undefined)
    await hook().onRunError!({ error: new Error('x'), fn, isFinalAttempt: true, ctx: {} } as never)
    expect(captureException).not.toHaveBeenCalled()
    expect(flush).not.toHaveBeenCalled()
  })
})
