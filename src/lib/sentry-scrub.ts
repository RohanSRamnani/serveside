/**
 * `beforeSend` for every Sentry event this app emits, server and browser alike: an
 * event in, a copy with the personal data gone out.
 *
 * What it protects is on every order — a customer's name, phone and email, and the free
 * text they typed into `notes` — plus the one secret that ever reaches a browser, a
 * Stripe PaymentIntent's client secret, which is what lets a page confirm a payment.
 * None of it belongs in a third party's error tracker, and none of it helps anyone read
 * an error.
 *
 * Two passes, because the data turns up in two shapes:
 *
 * - **By key**, wherever it sits in the event: a field named like contact data is
 *   replaced whole. Keys are compared with case, `_` and `-` removed, so `contactPhone`,
 *   `contact_phone` and `Contact-Phone` are one key. `name` counts only inside a
 *   `contact`/`customer` object — everywhere else in an event it names a runtime, an OS
 *   or an SDK, and removing those makes the event unreadable.
 * - **By pattern**, in every string: error messages and log lines carry values nobody
 *   could name a key for in advance (Twilio's refusal names the number it would not
 *   text). E.164 and `(555) 123-4567` phones, email addresses and client secrets are
 *   replaced in place, leaving the rest of the sentence.
 *
 * And two things are dropped whole: `request.data` (a body on this app is a checkout or
 * a Stripe event — contact details or client secrets, never something an error needs)
 * and `request.cookies`.
 *
 * Pure and SDK-free on purpose, so `src/lib/sentry-scrub.test.ts` can test it on event
 * shapes with no Sentry anywhere. It copies rather than mutating: Sentry hands
 * `beforeSend` its own object, but a function that returned a modified argument would be
 * a trap for the next caller.
 */
export const REDACTED = '[redacted]'

const SENSITIVE_KEYS = new Set([
  'contactname', 'contactphone', 'contactemail',
  'customername', 'customerphone', 'customeremail',
  'phone', 'phonee164', 'email', 'notes', 'note',
  'clientsecret',
  'authorization', 'cookie', 'setcookie',
  'ipaddress',
])

/** The only parents under which a bare `name` is a person's name. */
const PERSON_PARENTS = new Set(['contact', 'customer'])

/** Replaced in place inside any string, in this order: secrets first, so an id inside one is never half-matched. */
const PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:pi|seti)_[A-Za-z0-9]+_secret_[A-Za-z0-9]+/g, '[client secret]'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
  [/\+[1-9]\d{6,14}/g, '[phone]'],
  [/\(\d{3}\)\s?\d{3}-\d{4}/g, '[phone]'],
]

export function scrubEvent<T>(event: T): T {
  return scrub(event, null, new WeakSet()) as T
}

function scrub(value: unknown, parentKey: string | null, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return scrubString(value)
  if (value === null || typeof value !== 'object' || value instanceof Date) return value
  // A cycle is an object reached again *on the current path*; the same object shared
  // by two branches is simply visited twice. Sentry normalises events before
  // `beforeSend`, so this is a guard, not a code path anybody expects to take.
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.map((item) => scrub(item, parentKey, seen))

    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
      out[key] = isSensitive(key, parentKey) || isDroppedRequestField(key, parentKey)
        ? REDACTED
        : scrub(child, key, seen)
    }
    return out
  } finally {
    seen.delete(value)
  }
}

function normalise(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '')
}

function isSensitive(key: string, parentKey: string | null): boolean {
  const normalised = normalise(key)
  if (SENSITIVE_KEYS.has(normalised)) return true
  return normalised === 'name' && parentKey !== null && PERSON_PARENTS.has(normalise(parentKey))
}

/** `request.data` and `request.cookies`, dropped whatever is in them. */
function isDroppedRequestField(key: string, parentKey: string | null): boolean {
  return parentKey === 'request' && (key === 'data' || key === 'cookies')
}

function scrubString(text: string): string {
  return PATTERNS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text)
}
