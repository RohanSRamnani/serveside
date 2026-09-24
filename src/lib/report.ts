import * as Sentry from '@sentry/nextjs'

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
 * Server-side only: it is imported by route handlers and Inngest functions. Without a
 * DSN the SDK was never initialised and the capture is a no-op.
 *
 * **It never throws.** It is called from inside `catch` blocks and cleanup paths, where a
 * second exception would replace the one being reported with a worse one.
 */
export function reportError(...args: unknown[]): void {
  console.error(...args)
  try {
    const line = args.map(describe).join(' ')
    const error = args.find((arg): arg is Error => arg instanceof Error)
    if (error) Sentry.captureException(error, { extra: { log: line } })
    else Sentry.captureMessage(line, 'error')
  } catch {
    // Reporting is best-effort. The log line above has already been written.
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
