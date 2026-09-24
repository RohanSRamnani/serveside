import * as Sentry from '@sentry/nextjs'
import { sentryInitOptions } from '@/lib/sentry-config'

/**
 * Server-side instrumentation: Sentry, when there is a DSN to report to.
 *
 * **Why this file and not `sentry.server.config.ts`.** The plan named the SDK's old
 * per-runtime config files; `@sentry/nextjs` 11 on Next 16 wants `Sentry.init` inside the
 * `register()` of Next's instrumentation file — its own build warns, of a
 * `sentry.server.config.ts`, "put this file's content into the `register()` function of
 * a Next.js instrumentation file instead" — and it lives in `src/` because the app does
 * (`src/app`). One `register()` covers both server runtimes: the package's export
 * conditions hand the edge runtime the edge build of the same `init`.
 *
 * **Blank-safe.** No `SENTRY_DSN`, no `init`: nothing is patched and nothing is sent. That
 * is how this runs locally and until the Sentry project exists. See `sentryInitOptions`.
 *
 * What reaches Sentry from the server, once it is on:
 *
 * - `onRequestError` — anything a route, page or server component **throws**, which Next
 *   reports here after catching it.
 * - `reportError` (`src/lib/report.ts`) — the failures the routes catch and answer for
 *   themselves, which is most of them: a 500 here is almost always a caught error.
 * - `SentryMiddleware` (`src/inngest/sentry-middleware.ts`) — an Inngest run that failed
 *   for good, which Inngest catches before Next could see it.
 */
export async function register(): Promise<void> {
  const options = sentryInitOptions(process.env.SENTRY_DSN)
  if (options) Sentry.init(options)
}

export const onRequestError = Sentry.captureRequestError
