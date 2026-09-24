import type { init } from '@sentry/nextjs'
import { scrubEvent } from './sentry-scrub'

/** Whatever `Sentry.init` takes — server, edge and browser share this one shape. */
export type SentryOptions = NonNullable<Parameters<typeof init>[0]>

/**
 * **What the SDK may collect on its own for a request: almost nothing.**
 *
 * Sentry 11 replaced `sendDefaultPii` with this option, and every category in it
 * defaults to **on** — checked in the installed SDK, not assumed
 * (`@sentry/core/build/cjs/utils/data-collection/resolveDataCollectionOptions.js`). Left
 * at the defaults it would ship the body of every checkout POST (a customer's name,
 * phone, email and notes), cookies, request and response headers, the request's query
 * string, and the local variables of every stack frame, where an `input.contact` sits in
 * plain sight. So each is switched off by name. The two headers kept are what reading a
 * browser error needs and nothing else. `frameContextLines` is left alone: it is our own
 * source code around a frame, not anybody's data.
 *
 * **It is not the whole defence, and must not be read as one.** It governs what the SDK
 * collects about the request itself, and several things reach an event around it: Next's
 * `request_path` (query string included — CloudPRNT's carries the printer's MAC and job
 * token) in `contexts.nextjs`, the URL paths of outgoing-request breadcrumbs (Inngest's
 * event key is in one), console breadcrumbs, and error messages (drizzle's include the
 * query's parameters). Those are `scrubEvent`'s job; see `sentry-scrub.ts`, and
 * `sentry-pipeline.test.ts`, which sends all of them through the real SDK.
 */
export const DATA_COLLECTION = {
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
} satisfies SentryOptions['dataCollection']

/**
 * **How long a flush may take**, where the app flushes for itself: `reportError` (after
 * the response, through Next's `after`) and `SentryMiddleware` (before an Inngest run
 * answers). The SDK does not flush on its own here — its route wrappers come from
 * `withSentryConfig`, which is not used — and a serverless function can be suspended
 * once it has answered. Two seconds is ample for one or two small events and short
 * enough not to matter to a function that is otherwise done.
 */
export const SENTRY_FLUSH_MS = 2_000

/**
 * The one decision `src/instrumentation.ts` (server and edge) and
 * `src/instrumentation-client.ts` (browser) both make: how to start Sentry, or whether
 * to start it at all.
 *
 * **No DSN, no Sentry.** `null` means the caller does not call `init`, so nothing is
 * patched, nothing is sent and — in the browser — nothing is even downloaded. That is
 * how this runs locally, in the suite, and on every deployment until the founder creates
 * the Sentry project; blank and whitespace count as unset, because an unset Vercel
 * variable arrives as `''`.
 *
 * With one, it reports **errors and nothing personal**, in two layers:
 *
 * - {@link DATA_COLLECTION} — the SDK does not gather the request's own data in the
 *   first place;
 * - `beforeSend: scrubEvent` — and whatever an event still carries (a request path's
 *   query, an outgoing request's URL, a log line, an error message) is scrubbed on the
 *   way out. See `sentry-scrub.ts`.
 *
 * **No tracing** (`tracesSampleRate` left unset): errors only. A span per request would
 * ship the URL and timing of every customer's checkout for no alarm's benefit.
 */
export function sentryInitOptions(dsn: string | undefined): SentryOptions | null {
  const trimmed = dsn?.trim()
  if (!trimmed) return null
  return {
    dsn: trimmed,
    dataCollection: DATA_COLLECTION,
    beforeSend: (event) => scrubEvent(event),
  }
}
