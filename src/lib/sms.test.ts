import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { sendSms } from './sms'

/**
 * The SMS wrapper is the only thing in this repo that talks to a network the tests
 * cannot see, so the whole file is about proving what leaves the process without
 * ever letting one leave it. `fetch` is stubbed globally: a test that reaches Twilio
 * is a test that spends money and fails in CI.
 */
const ACCOUNT_SID = 'AC_test_account'
const AUTH_TOKEN = 'super_secret_token'
const FROM = '+15550000001'

/** The last request `sendSms` made, as `fetch` saw it. */
type Captured = { url: string; init: RequestInit }

let captured: Captured[] = []
let respond: () => Response

function fetchSpy() {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    captured.push({ url: String(url), init: init ?? {} })
    return respond()
  })
}

/** The form body Twilio is posted, decoded back into fields. */
function formOf(init: RequestInit): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(String(init.body)))
}

beforeEach(() => {
  captured = []
  respond = () => new Response(JSON.stringify({ sid: 'SM_test_1', status: 'queued' }), { status: 201 })
  vi.stubEnv('TWILIO_ACCOUNT_SID', ACCOUNT_SID)
  vi.stubEnv('TWILIO_AUTH_TOKEN', AUTH_TOKEN)
  vi.stubEnv('TWILIO_FROM_E164', FROM)
  // Off production every send is a dry run; these tests are about the live request.
  vi.stubEnv('VERCEL_ENV', 'development')
  vi.stubEnv('OUTBOUND_FORCE_LIVE_SMS', '1')
  vi.stubGlobal('fetch', fetchSpy())
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('sendSms', () => {
  it('posts the message to the account that is sending it, with basic auth', async () => {
    await sendSms('+15551234567', 'New order K7M2 — $45.24.')

    expect(captured).toHaveLength(1)
    const [{ url, init }] = captured
    // The SID is in the path, so an account mix-up is visible in a log line rather
    // than only in Twilio's console.
    expect(url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`)
    expect(init.method).toBe('POST')

    const headers = new Headers(init.headers)
    expect(headers.get('content-type')).toBe('application/x-www-form-urlencoded')
    // Twilio's REST API is HTTP basic auth, `sid:token` — not a bearer token.
    expect(headers.get('authorization'))
      .toBe(`Basic ${Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64')}`)

    // Form-encoded, not JSON: Twilio's 2010 API accepts nothing else.
    expect(formOf(init)).toEqual({
      To: '+15551234567',
      From: FROM,
      Body: 'New order K7M2 — $45.24.',
    })
  })

  it('refuses a number that is not E.164, without spending a request on it', async () => {
    // `locations.phone_e164` is a plain text column, so nothing but this stops a
    // number typed as `(555) 123-4567` reaching Twilio — where it is a 400 with a
    // code nobody reads, and the owner simply never hears about the order.
    await expect(sendSms('555-123-4567', 'hi')).rejects.toThrow(/E\.164/)
    expect(captured).toHaveLength(0)
  })

  it('throws when Twilio refuses the message, and never puts the auth token in the error', async () => {
    // The whole point of throwing: an SMS that silently fails is an owner who does
    // not know they have an order. The step fails, Inngest retries it, and the run
    // shows red if it never goes.
    respond = () => new Response(
      JSON.stringify({ code: 21211, message: "The 'To' number is not a valid phone number" }),
      { status: 400 },
    )

    const failure = await sendSms('+15551234567', 'hi').catch((err: Error) => err)
    expect(failure).toBeInstanceOf(Error)
    const text = `${(failure as Error).message}\n${(failure as Error).stack ?? ''}`
    expect(text).toContain('400')
    expect(text).toContain('21211')
    // A credential in an exception ends up in a log aggregator, a dashboard and a
    // bug report. Assert it is not there rather than trusting that nobody added it.
    expect(text).not.toContain(AUTH_TOKEN)
  })

  it('refuses to send at all when Twilio is not configured', async () => {
    // A blank var is how this fails in production — a deploy with the secret unset —
    // and `env()` makes that loud instead of sending to `undefined`.
    vi.stubEnv('TWILIO_AUTH_TOKEN', '')
    await expect(sendSms('+15551234567', 'hi')).rejects.toThrow(/TWILIO_AUTH_TOKEN/)
    expect(captured).toHaveLength(0)
  })

  it('off production, logs the message instead of sending it', async () => {
    // Dev and preview read a database of real owners' phones. A seeded order there
    // must never text one.
    vi.stubEnv('OUTBOUND_FORCE_LIVE_SMS', '')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await sendSms('+15551234567', 'New order K7M2 — $45.24. Open the feed to accept it.')

    expect(captured).toHaveLength(0)
    expect(log).toHaveBeenCalledWith('[sms:dry-run] to=4567 body=New order K7M2 — $45.24. Open the feed t')
    log.mockRestore()
  })

  it('still refuses a bad number in a dry run', async () => {
    vi.stubEnv('OUTBOUND_FORCE_LIVE_SMS', '')
    await expect(sendSms('555-123-4567', 'hi')).rejects.toThrow(/E\.164/)
  })
})
