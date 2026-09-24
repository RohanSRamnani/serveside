import { describe, it, expect } from 'vitest'
import { scrubEvent, REDACTED } from './sentry-scrub'

/**
 * What leaves this system for Sentry's servers. A customer's name, phone number and
 * email are on every order, the notes field is free text they typed, and a Stripe
 * client secret is what lets a browser confirm a payment — none of it belongs in a
 * third party's error tracker, whatever shape the event happens to carry it in.
 *
 * `scrubEvent` is `beforeSend`, and pure: an event in, a copy with the contact data
 * gone out. So it is tested here on the event shapes Sentry actually builds, with no SDK.
 */
const SECRET = 'pi_3Q0abcDEF123_secret_Zyx987wvU'
const INNGEST_KEY = 'aSecretInngestEventKey_0123456789abcdefABCDEF-xyz'
const MAC = '00:11:62:aa:bb:cc'
const ENCODED_MAC = '00%3A11%3A62%3Aaa%3Abb%3Acc'
const JOB_TOKEN = '11111111-1111-4111-8111-111111111111'

describe('scrubEvent', () => {
  it('removes contact fields wherever the event carries them', () => {
    const scrubbed = scrubEvent({
      extra: {
        body: {
          contact: { name: 'Rohan R', phone: '+15551234567', email: 'rohan@example.com' },
          items: [{ menuItemId: 'item-1', qty: 2, notes: 'no peanuts, severe allergy' }],
          notes: 'ring the bell',
        },
        order: { contactName: 'Rohan R', contact_phone: '+15551234567', 'contact-email': 'r@example.com' },
      },
    })

    expect(scrubbed.extra.body.contact).toEqual({ name: REDACTED, phone: REDACTED, email: REDACTED })
    expect(scrubbed.extra.body.items[0]).toEqual({ menuItemId: 'item-1', qty: 2, notes: REDACTED })
    expect(scrubbed.extra.body.notes).toBe(REDACTED)
    expect(scrubbed.extra.order).toEqual({ contactName: REDACTED, contact_phone: REDACTED, 'contact-email': REDACTED })
  })

  it('keeps every other `name` — the runtime, the OS, the error class', () => {
    // `name` is only contact data inside a contact. Everywhere else in an event it is
    // the thing you need to read the event at all.
    const scrubbed = scrubEvent({
      contexts: { runtime: { name: 'node', version: 'v22.14.0' }, os: { name: 'Linux' } },
      exception: { values: [{ type: 'StripeAPIError', value: 'api down' }] },
      sdk: { name: 'sentry.javascript.nextjs' },
    })
    expect(scrubbed.contexts.runtime.name).toBe('node')
    expect(scrubbed.contexts.os.name).toBe('Linux')
    expect(scrubbed.sdk.name).toBe('sentry.javascript.nextjs')
    expect(scrubbed.exception.values[0]).toEqual({ type: 'StripeAPIError', value: 'api down' })
  })

  it('takes the Stripe client secret out of keys and out of text', () => {
    const scrubbed = scrubEvent({
      extra: { clientSecret: SECRET, response: { client_secret: SECRET } },
      message: `confirm failed for ${SECRET}`,
      breadcrumbs: [{ message: `POST /api/orders → ${SECRET}` }],
    })
    expect(scrubbed.extra).toEqual({ clientSecret: REDACTED, response: { client_secret: REDACTED } })
    expect(scrubbed.message).not.toContain(SECRET)
    expect(scrubbed.breadcrumbs[0].message).not.toContain(SECRET)
    expect(scrubbed.message).toContain('[client secret]')
  })

  it('takes phone numbers and email addresses out of free text — error messages included', () => {
    // Twilio's refusal names the number it would not text, and it reaches us as an
    // exception message, not as a field anybody could name in advance.
    const scrubbed = scrubEvent({
      exception: { values: [{ type: 'Error', value: 'Twilio refused the message to +19179090243: 400' }] },
      message: 'order for rohan@example.com, call (555) 123-4567',
      extra: { log: '[POST /api/orders] contact +15551234567 rejected' },
    })
    expect(scrubbed.exception.values[0].value).toBe('Twilio refused the message to [phone]: 400')
    expect(scrubbed.message).toBe('order for [email], call [phone]')
    expect(scrubbed.extra.log).toBe('[POST /api/orders] contact [phone] rejected')
  })

  it('drops request bodies and cookies whole, and the credentials in headers', () => {
    // A request body on this app is a checkout (a customer's contact details) or a
    // Stripe event (client secrets and all). No error needs one to be read.
    const scrubbed = scrubEvent({
      request: {
        url: 'https://serveside.app/api/orders',
        method: 'POST',
        data: '{"contact":{"name":"Rohan R","phone":"+15551234567"}}',
        cookies: { __session: 'abc' },
        headers: { authorization: 'Bearer sk_live_xyz', cookie: '__session=abc', 'user-agent': 'Mobile Safari' },
      },
    })
    expect(scrubbed.request.data).toBe(REDACTED)
    expect(scrubbed.request.cookies).toBe(REDACTED)
    expect(scrubbed.request.headers).toEqual({
      authorization: REDACTED, cookie: REDACTED, 'user-agent': 'Mobile Safari',
    })
    expect(scrubbed.request.url).toBe('https://serveside.app/api/orders')
  })

  it('removes what would identify a person on the user record', () => {
    const scrubbed = scrubEvent({ user: { id: 'user_2abc', email: 'owner@kashi.test', ip_address: '203.0.113.9' } })
    expect(scrubbed.user).toEqual({ id: 'user_2abc', email: REDACTED, ip_address: REDACTED })
  })

  it('leaves ids, amounts and everything that is not contact data exactly as it was', () => {
    const event = {
      event_id: 'abc123',
      level: 'error',
      timestamp: 1790000000,
      tags: { route: '/api/orders', inngest_function: 'order-created-fan-out' },
      extra: { orderId: '11111111-1111-4111-8111-111111111111', totalCents: 4524, paid: false, refund: null },
    }
    expect(scrubEvent(event)).toEqual(event)
  })

  // --- Fix round 1: what DATA_COLLECTION cannot reach. Each shape below is the one the
  // installed SDK actually builds — observed in-process, and asserted again end to end in
  // `sentry-pipeline.test.ts`.

  it('keeps only the origin of an outgoing request breadcrumb — Inngest puts its event key in the path', () => {
    // `inngest.send` POSTs to `https://inn.gs/e/<INNGEST_EVENT_KEY>`, and the SDK's fetch
    // breadcrumb keeps the whole path (only userinfo and the query are filtered). Every
    // event captured later in the same request would carry the key.
    const scrubbed = scrubEvent({
      breadcrumbs: [{
        type: 'http',
        category: 'http',
        data: { status_code: 200, url: `https://inn.gs/e/${INNGEST_KEY}`, 'http.request.method': 'POST' },
      }, {
        type: 'http',
        category: 'http',
        data: { status_code: 201, url: 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json', 'url.query': 'x=1' },
      }],
    })
    expect(scrubbed.breadcrumbs[0].data).toEqual({ status_code: 200, url: 'https://inn.gs', 'http.request.method': 'POST' })
    expect(scrubbed.breadcrumbs[1].data).toEqual({ status_code: 201, url: 'https://api.twilio.com' })
    expect(JSON.stringify(scrubbed)).not.toContain(INNGEST_KEY)
  })

  it('keeps the path of a relative request — our own API — but never its query', () => {
    const scrubbed = scrubEvent({
      breadcrumbs: [{ type: 'http', category: 'fetch', data: { method: 'POST', url: '/api/orders?debug=1', status_code: 422 } }],
    })
    expect(scrubbed.breadcrumbs[0].data.url).toBe('/api/orders')
  })

  it('takes a printer serial out of a console breadcrumb — its message and its arguments', () => {
    // `console.warn('[cloudprnt] printer', serial, 'reports', …)` on every poll becomes a
    // breadcrumb, and a Star printer's serial is its MAC: the whole of its credential.
    const scrubbed = scrubEvent({
      breadcrumbs: [{
        category: 'console',
        level: 'warning',
        message: `[cloudprnt] printer ${MAC} reports 200 OK`,
        data: { arguments: ['[cloudprnt] printer', MAC, 'reports', '200 OK'], logger: 'console' },
      }],
    })
    expect(scrubbed.breadcrumbs[0].message).toBe('[cloudprnt] printer [mac] reports 200 OK')
    expect(scrubbed.breadcrumbs[0].data.arguments).toEqual(['[cloudprnt] printer', '[mac]', 'reports', '200 OK'])
  })

  it('strips the query from the request path Next hands onRequestError — CloudPRNT’s carries the MAC and the job token', () => {
    // `captureRequestError` copies Next's `request.path` into `contexts.nextjs` unfiltered,
    // and that path includes the query string; `urlQueryParams: false` never sees it.
    const scrubbed = scrubEvent({
      contexts: {
        nextjs: {
          request_path: `/api/printers/cloudprnt?mac=${ENCODED_MAC}&token=${JOB_TOKEN}`,
          router_kind: 'App Router',
          router_path: '/api/printers/cloudprnt',
          route_type: 'route',
        },
      },
      request: { url: `https://serveside.app/api/printers/cloudprnt?mac=${ENCODED_MAC}&token=${JOB_TOKEN}`, method: 'GET' },
    })
    expect(scrubbed.contexts.nextjs.request_path).toBe('/api/printers/cloudprnt')
    expect(scrubbed.contexts.nextjs.router_path).toBe('/api/printers/cloudprnt')
    expect(scrubbed.request.url).toBe('https://serveside.app/api/printers/cloudprnt')
    expect(JSON.stringify(scrubbed)).not.toContain(JOB_TOKEN)
  })

  it('takes MACs out of free text in either spelling, and an event key out of a URL in a message', () => {
    const scrubbed = scrubEvent({
      message: `poll from ${MAC.toUpperCase()} and ${ENCODED_MAC}, then POST https://inn.gs/e/${INNGEST_KEY} failed`,
    })
    expect(scrubbed.message).toBe('poll from [mac] and [mac], then POST https://inn.gs/e/[inngest event key] failed')
  })

  it('keeps a failed query’s SQL and drops its parameters — the order INSERT’s are a customer’s details', () => {
    // drizzle's `DrizzleQueryError` message is `Failed query: <sql>\nparams: <values>`, so
    // a database blip on `createOrder` would put a name and the notes they typed into
    // Sentry as the exception's value.
    const failed = 'Failed query: insert into "orders" ("contact_name", "contact_phone", "notes") values ($1, $2, $3)'
      + '\nparams: Rohan R,+15551234567,no peanuts — severe allergy'
    const scrubbed = scrubEvent({
      exception: { values: [{ type: 'DrizzleQueryError', value: failed }] },
      extra: { log: `[POST /api/orders] unexpected failure: DrizzleQueryError: ${failed}` },
    })
    expect(scrubbed.exception.values[0].value).toBe(
      'Failed query: insert into "orders" ("contact_name", "contact_phone", "notes") values ($1, $2, $3)'
      + '\nparams: [redacted]',
    )
    expect(scrubbed.extra.log).not.toMatch(/Rohan|peanuts|15551234567/)
  })

  it('does not change the event it was handed, and survives a cycle', () => {
    const extra: Record<string, unknown> = { phone: '+15551234567' }
    extra.self = extra
    const event = { extra }

    const scrubbed = scrubEvent(event)

    expect(extra.phone).toBe('+15551234567')
    expect(scrubbed.extra.phone).toBe(REDACTED)
    expect((scrubbed.extra as Record<string, unknown>).self).toBe('[circular]')
  })
})
