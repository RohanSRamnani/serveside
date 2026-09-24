import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * The bridge from a failed Inngest run to a Sentry event.
 *
 * Inngest catches whatever a function throws and reports it to the orchestrator, so it
 * never reaches Next's `onRequestError`: without this, a fan-out that failed for good
 * is a red run in a dashboard nobody has open. **Final attempts only** — Inngest retries
 * a failed run, and an event per attempt would be four events for one failure, and an
 * event for a failure its own retry then fixed.
 */
const { captureException } = vi.hoisted(() => ({ captureException: vi.fn() }))
vi.mock('@sentry/nextjs', () => ({ captureException }))

const { SentryMiddleware } = await import('./sentry-middleware')
const { inngest } = await import('./client')

const fn = { id: () => 'serveside-order-created-fan-out' }

function hook() {
  return new SentryMiddleware({ client: inngest })
}

beforeEach(() => {
  captureException.mockReset()
})

describe('SentryMiddleware', () => {
  it('captures a run that has failed for good, tagged with the function', () => {
    const error = new Error('order ord-1 fan-out incomplete — sms-owner: twilio is down')

    hook().onRunError!({ error, fn, isFinalAttempt: true, ctx: {} } as never)

    expect(captureException).toHaveBeenCalledTimes(1)
    expect(captureException).toHaveBeenCalledWith(error, {
      tags: { inngest_function: 'serveside-order-created-fan-out' },
    })
  })

  it('stays quiet about an attempt Inngest is still going to retry', () => {
    hook().onRunError!({ error: new Error('blip'), fn, isFinalAttempt: false, ctx: {} } as never)
    expect(captureException).not.toHaveBeenCalled()
  })
})
