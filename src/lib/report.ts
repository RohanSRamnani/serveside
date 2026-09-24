import * as Sentry from '@sentry/nextjs'
import { after } from 'next/server'
import { SENTRY_FLUSH_MS } from './sentry-config'

/**
 * `console.error`, plus one Sentry event. What the API routes and the alarms call where
 * a real failure used to be a log line and nothing else.
 *
 * The house style is a bracketed prefix and the ids that matter —
 * `reportError('[POST /api/orders] …', orderId, err)` — and that line still goes to the
 * log exactly as it did, because humans and the existing tests both read it. The event
 * carries **the error object itself** when one of the arguments is an Error (so Sentry
 * groups by its stack and type) with the whole line alongside as `extra.log`, and is a
 * message-level event when there is nothing to throw. `beforeSend` scrubs both.
 *
 * **Then it makes sure the event leaves.** The SDK flushes on its own only inside the
 * route wrappers `withSentryConfig` injects, which this app does not use, and a
 * serverless function can be suspended the moment it has answered — so an event captured
 * here could sit in the SDK's buffer until the instance is gone. It is the only alarm for
 * some failures (an order nobody could announce), so a flush is scheduled with Next's
 * `after`: it runs once the response has been sent, and the platform keeps the function
 * alive for it (`waitUntil` on Vercel). `after` exists only inside a request; outside one
 * there is no response to wait for, so it flushes at once.
 *
 * Without a DSN there is no client, and then nothing is captured, scheduled or flushed.
 *
 * **It never throws.** It is called from inside `catch` blocks and cleanup paths, where a
 * second exception would replace the one being reported with a worse one.
 */
export function reportError(...args: unknown[]): void {
  console.error(...args)
  try {
    if (!Sentry.getClient()) return
    const line = args.map(describe).join(' ')
    const error = args.find((arg): arg is Error => arg instanceof Error)
    if (error) Sentry.captureException(error, { extra: { log: line } })
    else Sentry.captureMessage(line, 'error')
    flushWhenAnswered()
  } catch {
    // Reporting is best-effort. The log line above has already been written.
  }
}

function flushWhenAnswered(): void {
  try {
    after(() => Sentry.flush(SENTRY_FLUSH_MS))
  } catch {
    // Not inside a request (`after` throws there): nothing will be answered, so nothing
    // to wait for. Start the flush now; its failure is not ours to report.
    void Promise.resolve(Sentry.flush(SENTRY_FLUSH_MS)).catch(() => {})
  }
}

function describe(arg: unknown): string {
  if (typeof arg === 'string') return arg
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`
  try {
    return JSON.stringify(arg) ?? String(arg)
  } catch {
    return String(arg)
  }
}
