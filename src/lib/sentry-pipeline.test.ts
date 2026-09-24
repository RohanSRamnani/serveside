import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import * as Sentry from '@sentry/nextjs'
import { DrizzleQueryError } from 'drizzle-orm'
import { sentryInitOptions } from './sentry-config'
import { reportError } from './report'

/**
 * **The real SDK, our real options, and a transport that records instead of sending.**
 *
 * `sentry-scrub.test.ts` pins the scrubber on hand-built event shapes; this proves the
 * shapes are the ones the installed SDK actually builds, and that nothing survives the
 * whole pipeline — `DATA_COLLECTION`, the SDK's own processing, then `beforeSend`. It is
 * what turns "the event key leaks through a fetch breadcrumb" from a reading of the SDK's
 * source into an observation: with the scrubber doing nothing, every assertion below
 * about a secret fails.
 *
 * One request's worth of trouble, as it would happen on a server: an Inngest send (its
 * event key is in the URL path), a CloudPRNT poll's log line (a printer's MAC is its
 * credential), then both ways an error reaches Sentry — a route's thrown error through
 * `onRequestError`, whose request path carries the printer's MAC and job token, and a
 * caught one through `reportError`: a failed order INSERT, whose message carries the
 * customer's details.
 *
 * `Sentry.init` is global state, which is why this is its own file: vitest runs each file
 * in its own process (`pool: 'forks'`), so no other test sees an initialised client.
 */
const INNGEST_KEY = 'aSecretInngestEventKey_0123456789abcdefABCDEF-xyz'
const MAC = '00:11:62:aa:bb:cc'
const ENCODED_MAC = '00%3A11%3A62%3Aaa%3Abb%3Acc'
const JOB_TOKEN = '22222222-2222-4222-8222-222222222222'
const CUSTOMER = ['Rohan R', '+15551234567', 'rohan@example.com', 'no peanuts, severe allergy']
/**
 * Up here, not inline at the call: the SDK quotes a few lines of *source* around each
 * stack frame (context lines), so a literal written beside the capture call would appear
 * in the event as code. Production context lines are our own source, which never holds
 * a customer's data or a secret — only a test's source does.
 */
const REQUEST_HEADERS = { cookie: 'session=abc', 'x-forwarded-for': '203.0.113.9', 'user-agent': 'Star CloudPRNT' }

type Envelope = [unknown, Array<[{ type?: string }, Record<string, unknown>]>]
const sent: Envelope[] = []
let server: Server
let origin = ''

beforeAll(async () => {
  // Silenced *before* Sentry wraps the console, so the SDK still records the breadcrumb
  // and then calls the silent spy instead of printing a fake MAC into the test log.
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})

  Sentry.init({
    ...sentryInitOptions('https://public@o0.ingest.sentry.io/0')!,
    transport: () => ({
      send: async (envelope: unknown) => { sent.push(envelope as Envelope); return {} },
      flush: async () => true,
    }),
  })

  server = createServer((_req, res) => res.end('{}'))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await Sentry.close(2000)
  await new Promise((resolve) => server.close(resolve))
  vi.restoreAllMocks()
})

function events(): Array<Record<string, unknown>> {
  return sent.flatMap(([, items]) => items).filter(([header]) => header.type === 'event').map(([, event]) => event)
}

describe('an event, through the real Sentry pipeline', () => {
  it('carries none of the secrets the request touched', async () => {
    await fetch(`${origin}/e/${INNGEST_KEY}`, { method: 'POST', body: '{}' })
    console.warn('[cloudprnt] printer', MAC, 'reports', '200 OK')

    Sentry.captureRequestError(
      new Error('db blip'),
      {
        path: `/api/printers/cloudprnt?mac=${ENCODED_MAC}&token=${JOB_TOKEN}`,
        method: 'GET',
        headers: REQUEST_HEADERS,
      },
      { routerKind: 'App Router', routePath: '/api/printers/cloudprnt', routeType: 'route' },
    )
    reportError('[POST /api/orders] unexpected failure:', new DrizzleQueryError(
      'insert into "orders" ("contact_name", "contact_phone", "contact_email", "notes") values ($1, $2, $3, $4)',
      CUSTOMER,
      new Error('connection reset'),
    ))
    await Sentry.flush(2000)

    // Two events really went out — so the absences below are not vacuous.
    const sentEvents = events()
    expect(sentEvents).toHaveLength(2)

    const everything = JSON.stringify(sent)
    for (const secret of [INNGEST_KEY, MAC, ENCODED_MAC, JOB_TOKEN, ...CUSTOMER, '203.0.113.9', 'session=abc']) {
      expect(everything, `leaked: ${secret}`).not.toContain(secret)
    }

    // And what is left is still an event somebody can act on.
    const [routeError, caught] = sentEvents as Array<{
      contexts: { nextjs?: { request_path?: string } }
      breadcrumbs: Array<{ category?: string; data?: { url?: string }; message?: string }>
      exception: { values: Array<{ value?: string }> }
      extra?: { log?: string }
    }>
    expect(routeError.contexts.nextjs?.request_path).toBe('/api/printers/cloudprnt')
    expect(routeError.exception.values.at(-1)?.value).toBe('db blip')
    expect(routeError.breadcrumbs.find((b) => b.category === 'http')?.data?.url).toBe(origin)
    expect(routeError.breadcrumbs.find((b) => b.category === 'console')?.message)
      .toBe('[cloudprnt] printer [mac] reports 200 OK')
    expect(caught.extra?.log).toContain('Failed query: insert into "orders"')
    expect(caught.extra?.log).toContain('params: [redacted]')
  })
})
