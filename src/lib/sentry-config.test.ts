import { describe, it, expect } from 'vitest'
import { sentryInitOptions } from './sentry-config'
import { REDACTED } from './sentry-scrub'

/**
 * The one decision both `src/instrumentation.ts` (server) and
 * `src/instrumentation-client.ts` (browser) make: initialise Sentry, or do nothing.
 *
 * **Blank means off**, and off means off: no DSN is how this runs locally, in the
 * suite, and on every deployment until the Sentry project exists — and an unset Vercel
 * variable arrives as `''`, not `undefined`, so both are the same answer.
 */
describe('sentryInitOptions', () => {
  it('is nothing at all when there is no DSN', () => {
    expect(sentryInitOptions(undefined)).toBeNull()
    expect(sentryInitOptions('')).toBeNull()
    expect(sentryInitOptions('   ')).toBeNull()
  })

  it('reports errors and nothing personal once a DSN is set', () => {
    const options = sentryInitOptions(' https://abc@o1.ingest.sentry.io/2 ')

    expect(options).not.toBeNull()
    expect(options!.dsn).toBe('https://abc@o1.ingest.sentry.io/2')
    // Sentry 11 collects every one of these by default. Each is off, by name: request
    // and response bodies (a checkout is a customer's contact details), cookies, user
    // info, query strings (CloudPRNT's carries the printer's MAC — its credential),
    // database parameters, queue payloads and stack-frame local variables.
    expect(options!.dataCollection).toEqual({
      userInfo: false,
      cookies: false,
      httpHeaders: { request: { allow: ['user-agent', 'content-type'] }, response: false },
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    })
    // Errors only: tracing would ship a span for every request, and the spans carry the
    // URLs and timings of every customer's checkout.
    expect(options!).not.toHaveProperty('tracesSampleRate')
    expect(options!).not.toHaveProperty('tracesSampler')
  })

  it('scrubs every event on the way out', () => {
    const options = sentryInitOptions('https://abc@o1.ingest.sentry.io/2')!
    const event = { extra: { contact: { name: 'Rohan R', phone: '+15551234567' } } }

    const sent = options.beforeSend!(event as never, {}) as unknown as typeof event

    expect(sent.extra.contact).toEqual({ name: REDACTED, phone: REDACTED })
  })
})
