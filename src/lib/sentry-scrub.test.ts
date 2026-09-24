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
