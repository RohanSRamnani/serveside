import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * `reportError` is what the routes and the alarms call where they used to call
 * `console.error`: the same line in the log, **and** one event in Sentry. On a
 * serverless function a log line is something nobody reads until they already know to
 * look; an event is something that tells them to.
 *
 * **And the event has to leave the building.** The SDK flushes on its own only inside
 * the wrappers `withSentryConfig` injects, which this app does not use, and a Vercel
 * function can be suspended the moment it has answered — so an event captured in a
 * route could sit in the SDK's buffer until the instance dies. `reportError` therefore
 * schedules a flush with Next's `after`, which runs once the response is sent and is
 * what keeps the function alive for it. Outside a request (`after` throws there) it
 * flushes at once instead.
 *
 * The SDK and `next/server` are mocked at their module boundaries, so this pins what we
 * hand them. With no DSN the SDK has no client, and then nothing at all is captured,
 * scheduled or flushed.
 */
const { captureException, captureMessage, flush, getClient } = vi.hoisted(() => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  flush: vi.fn(),
  getClient: vi.fn(),
}))
vi.mock('@sentry/nextjs', () => ({ captureException, captureMessage, flush, getClient }))

const { after } = vi.hoisted(() => ({ after: vi.fn() }))
vi.mock('next/server', () => ({ after }))

const { reportError } = await import('./report')
const { SENTRY_FLUSH_MS } = await import('./sentry-config')

beforeEach(() => {
  captureException.mockReset()
  captureMessage.mockReset()
  flush.mockReset()
  flush.mockResolvedValue(true)
  getClient.mockReset()
  getClient.mockReturnValue({})
  after.mockReset()
})

/** Runs `fn` with `console.error` silenced, and hands back what it was called with. */
function quietly(fn: () => void): unknown[][] {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    fn()
    return [...error.mock.calls]
  } finally {
    error.mockRestore()
  }
}

describe('reportError', () => {
  it('logs the line and captures the error it carries, with the line as context', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const cause = new Error('api down')
    try {
      reportError('[POST /api/orders] Stripe could not open an intent for order', 'ord-1', '— converting:', cause)

      // The log line is exactly what it was — existing tests and humans read it.
      expect(error).toHaveBeenCalledWith(
        '[POST /api/orders] Stripe could not open an intent for order', 'ord-1', '— converting:', cause,
      )
      // One event, the real error (so Sentry groups by its stack), the line alongside.
      expect(captureException).toHaveBeenCalledTimes(1)
      expect(captureException).toHaveBeenCalledWith(cause, {
        extra: { log: '[POST /api/orders] Stripe could not open an intent for order ord-1 — converting: Error: api down' },
      })
      expect(captureMessage).not.toHaveBeenCalled()
    } finally {
      error.mockRestore()
    }
  })

  it('captures a message when there is no error object to capture', () => {
    quietly(() => reportError('[POST /api/orders] pay-at-pickup failover did not convert order', 'ord-2'))
    expect(captureMessage).toHaveBeenCalledWith(
      '[POST /api/orders] pay-at-pickup failover did not convert order ord-2', 'error',
    )
    expect(captureException).not.toHaveBeenCalled()
  })

  it('flushes the event once the response has gone, so a suspended function cannot strand it', async () => {
    quietly(() => reportError('[POST /api/orders] order ord-3 is NEW but could not be announced', new Error('hung')))

    // Scheduled, not run: the flush must not hold the customer's response.
    expect(after).toHaveBeenCalledTimes(1)
    expect(flush).not.toHaveBeenCalled()

    // What Next runs after the response, and what it waits on.
    const task = after.mock.calls[0][0] as () => Promise<unknown>
    await expect(task()).resolves.toBe(true)
    expect(flush).toHaveBeenCalledWith(SENTRY_FLUSH_MS)
    expect(SENTRY_FLUSH_MS).toBe(2_000)
  })

  it('flushes straight away outside a request, where there is no `after` to wait for', () => {
    after.mockImplementation(() => {
      throw new Error('`after` was called outside a request scope.')
    })
    quietly(() => reportError('[canary] something broke', new Error('x')))
    expect(captureException).toHaveBeenCalledTimes(1)
    expect(flush).toHaveBeenCalledWith(SENTRY_FLUSH_MS)
  })

  it('does nothing but log when there is no DSN — nothing captured, scheduled or flushed', () => {
    getClient.mockReturnValue(undefined)
    const logged = quietly(() => reportError('[GET /api/feed] failed for location', 'loc-1', new Error('x')))
    expect(logged).toHaveLength(1)
    expect(logged[0].slice(0, 2)).toEqual(['[GET /api/feed] failed for location', 'loc-1'])
    expect(captureException).not.toHaveBeenCalled()
    expect(captureMessage).not.toHaveBeenCalled()
    expect(after).not.toHaveBeenCalled()
    expect(flush).not.toHaveBeenCalled()
  })

  it('never throws, whatever it is handed — it runs inside catch blocks', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    captureMessage.mockImplementation(() => { throw new Error('sdk exploded') })
    after.mockImplementation(() => { throw new Error('no scope') })
    flush.mockRejectedValue(new Error('transport down'))
    expect(() => quietly(() => reportError('[x] odd argument', cyclic, undefined, 42))).not.toThrow()
  })
})
