import { env } from '@/lib/env'
import { outboundLive } from '@/lib/outbound'

/**
 * One text message, over Twilio's REST API.
 *
 * This is the leg of the order fan-out that reaches a human when the printer does
 * not, so its contract is narrow and unforgiving: it either delivers the message to
 * Twilio or it **throws**. There is no "best effort" here — a swallowed failure is an
 * owner who never learns they have an order, and the Inngest step that calls this is
 * what turns a throw into a retry and, eventually, into a red run somebody looks at.
 *
 * `fetch` rather than the `twilio` SDK: the whole client is one form POST, Node 22
 * has `fetch` built in, and a dependency that ships its own HTTP stack is a
 * dependency to keep patched forever. It also keeps the tests honest — they stub
 * `globalThis.fetch` and assert the exact request, so nothing can reach the network
 * from a test run.
 *
 * Env: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_E164`. Read per call
 * rather than at import, so a deploy with one of them unset fails the SMS step — and
 * only the SMS step — instead of failing the whole module at boot.
 */

/** The 2010 API is the current one; Twilio has never versioned past it. */
const TWILIO_API = 'https://api.twilio.com/2010-04-01'

/**
 * E.164: a `+`, a country code that does not start with 0, and at most 15 digits in
 * total. Checked here because `locations.phone_e164` is a plain `text` column and
 * nothing else stands between a number typed as `(555) 123-4567` and a Twilio 400
 * — which is a code nobody reads and an owner who is simply never told.
 */
const E164 = /^\+[1-9]\d{1,14}$/

export async function sendSms(to: string, body: string): Promise<void> {
  if (!E164.test(to)) throw new Error(`sendSms: not an E.164 number: ${JSON.stringify(to)}`)

  // After the E.164 check, so dev still catches a bad number. Last 4 digits only: a
  // dev log is not a place for a restaurant owner's phone number.
  if (!outboundLive('sms')) {
    console.log(`[sms:dry-run] to=${to.slice(-4)} body=${body.slice(0, 40)}`)
    return
  }

  const accountSid = env('TWILIO_ACCOUNT_SID')
  const authToken = env('TWILIO_AUTH_TOKEN')

  const res = await fetch(`${TWILIO_API}/Accounts/${encodeURIComponent(accountSid)}/Messages.json`, {
    method: 'POST',
    headers: {
      // HTTP basic, `sid:token` — Twilio does not take a bearer token.
      authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    // `URLSearchParams`, so a message body containing `&` or `=` cannot rewrite the
    // form it is being sent in.
    body: new URLSearchParams({ To: to, From: env('TWILIO_FROM_E164'), Body: body }),
  })

  if (!res.ok) {
    // Twilio's body carries the code and the human explanation (21610 = the number
    // replied STOP, 21211 = not a valid number) and is the only thing worth having in
    // the log. Bounded, because an error page from a proxy in front of Twilio is a
    // whole HTML document. **Never the token**: an exception ends up in a log
    // aggregator, a dashboard and a bug report.
    const detail = await res.text().catch(() => '')
    throw new Error(`Twilio refused the message to ${to}: ${res.status} ${detail.slice(0, 300)}`)
  }
}
