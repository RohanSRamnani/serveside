import { Middleware } from 'inngest'
import * as Sentry from '@sentry/nextjs'
import { SENTRY_FLUSH_MS } from '@/lib/sentry-config'

/**
 * Sends a run that has **failed for good** to Sentry — and waits for it to be sent.
 *
 * Inngest catches whatever a function throws and reports it to its own orchestrator, so
 * the error never reaches the Next.js request that carried it — `onRequestError` in
 * `src/instrumentation.ts` does not see it. Without this, a fan-out that ran out of
 * retries is a red run in a dashboard nobody has open.
 *
 * **Final attempts only.** Inngest retries a failed run, so an event per attempt would be
 * four events for one failure, plus an event for every failure its own retry then fixed.
 * A step whose failure the function catches (the canary's clean-up) never becomes a run
 * error at all; the function that caught it is responsible for recording it.
 *
 * **Awaited flush.** The SDK does not flush on its own in this app (no `withSentryConfig`
 * wrappers), and the function can be suspended as soon as it has answered the
 * orchestrator. Inngest awaits this hook before it answers, so awaiting the flush here is
 * what gets the event out while the function is still alive.
 *
 * Inert without a DSN: no client, so nothing is captured and nothing is flushed.
 */
export class SentryMiddleware extends Middleware.BaseMiddleware {
  readonly id = 'serveside:sentry'

  async onRunError({ error, fn, isFinalAttempt }: Middleware.OnRunErrorArgs): Promise<void> {
    if (!isFinalAttempt || !Sentry.getClient()) return
    Sentry.captureException(error, { tags: { inngest_function: fn.id() } })
    await Sentry.flush(SENTRY_FLUSH_MS)
  }
}
