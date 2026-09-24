import { Middleware } from 'inngest'
import * as Sentry from '@sentry/nextjs'

/**
 * Sends a run that has **failed for good** to Sentry.
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
 * Inert without a DSN: `captureException` on an SDK that was never initialised does
 * nothing, which is how the suite and every deployment without a Sentry project run.
 */
export class SentryMiddleware extends Middleware.BaseMiddleware {
  readonly id = 'serveside:sentry'

  onRunError({ error, fn, isFinalAttempt }: Middleware.OnRunErrorArgs): void {
    if (!isFinalAttempt) return
    Sentry.captureException(error, { tags: { inngest_function: fn.id() } })
  }
}
