import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { outboundLive } from './outbound'

beforeEach(() => {
  vi.stubEnv('VERCEL_ENV', '')
  vi.stubEnv('OUTBOUND_FORCE_LIVE_SMS', '')
  vi.stubEnv('OUTBOUND_FORCE_LIVE_EMAIL', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('outboundLive', () => {
  it('is live on both channels in production', () => {
    vi.stubEnv('VERCEL_ENV', 'production')
    expect(outboundLive('sms')).toBe(true)
    expect(outboundLive('email')).toBe(true)
  })

  it('is a dry run everywhere else, preview included', () => {
    expect(outboundLive('sms')).toBe(false)
    expect(outboundLive('email')).toBe(false)
    vi.stubEnv('VERCEL_ENV', 'preview')
    expect(outboundLive('sms')).toBe(false)
    expect(outboundLive('email')).toBe(false)
  })

  it('each force flag forces only its own channel', () => {
    // Separate flags so a developer testing email never texts a real owner.
    vi.stubEnv('OUTBOUND_FORCE_LIVE_EMAIL', '1')
    expect(outboundLive('email')).toBe(true)
    expect(outboundLive('sms')).toBe(false)

    vi.stubEnv('OUTBOUND_FORCE_LIVE_EMAIL', '')
    vi.stubEnv('OUTBOUND_FORCE_LIVE_SMS', '1')
    expect(outboundLive('sms')).toBe(true)
    expect(outboundLive('email')).toBe(false)
  })
})
