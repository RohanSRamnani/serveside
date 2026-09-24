import { sentryInitOptions } from '@/lib/sentry-config'

/**
 * Browser-side instrumentation: Sentry for the storefront and the kitchen feed, when
 * there is a DSN to report to. Next runs this before hydration on every page.
 *
 * **Why this file and not `sentry.client.config.ts`.** `@sentry/nextjs` 11 deprecates
 * the old file ("When using Turbopack `sentry.client.config.ts` will no longer work"),
 * and this app builds with Turbopack.
 *
 * **The SDK is loaded only when there is a DSN**, with a dynamic `import()`. The
 * storefront is phone-first and every kilobyte is paid for on a cellular connection, so
 * a deployment without Sentry — every one until the founder creates the project — ships
 * none of it. The cost of loading it this way is that an error thrown in the few
 * milliseconds before the chunk arrives is not reported; Next documents that anything
 * asynchronous here runs after hydration begins. `NEXT_PUBLIC_SENTRY_DSN` is read here
 * rather than `SENTRY_DSN` because only `NEXT_PUBLIC_` variables reach a browser — set
 * both to the same DSN.
 *
 * No Session Replay, deliberately: it would record the checkout form a customer types
 * their name and phone number into.
 */
const options = sentryInitOptions(process.env.NEXT_PUBLIC_SENTRY_DSN)
if (options) {
  void import('@sentry/nextjs')
    .then((Sentry) => Sentry.init(options))
    .catch(() => {
      // An ad blocker or a flaky connection kept the SDK from loading. The page is
      // unaffected, which is the only thing that matters here.
    })
}
