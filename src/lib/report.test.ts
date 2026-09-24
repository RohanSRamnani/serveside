import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * `reportError` is what the routes and the alarms call where they used to call
 * `console.error`: the same line in the log, **and** one event in Sentry. On a
 * serverless function a log line is something nobody reads until they already know to
 * look; an event is something that tells them to.
 *
 * The SDK is mocked at its module boundary, so this pins what we hand it. Without a DSN
 * the real SDK is never initialised and both calls are no-ops.
 */
const { captureException, captureMessage } = vi.hoisted(() => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}))
vi.mock('@sentry/nextjs', () => ({ captureException, captureMessage }))

const { reportError } = await import('./report')

beforeEach(() => {
  captureException.mockReset()
  captureMessage.mockReset()
})

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
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      reportError('[POST /api/orders] pay-at-pickup failover did not convert order', 'ord-2')
      expect(captureMessage).toHaveBeenCalledWith(
        '[POST /api/orders] pay-at-pickup failover did not convert order ord-2', 'error',
      )
      expect(captureException).not.toHaveBeenCalled()
    } finally {
      error.mockRestore()
    }
  })

  it('never throws, whatever it is handed — it runs inside catch blocks', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    captureMessage.mockImplementation(() => { throw new Error('sdk exploded') })
    try {
      expect(() => reportError('[x] odd argument', cyclic, undefined, 42)).not.toThrow()
    } finally {
      error.mockRestore()
    }
  })
})
