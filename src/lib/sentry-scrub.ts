/**
 * `beforeSend` for every Sentry event this app emits, server and browser alike: an
 * event in, a copy with the personal data and the credentials gone out.
 *
 * What it protects is on every order — a customer's name, phone and email, and the free
 * text they typed into `notes` — plus the secrets that pass through a request: a Stripe
 * PaymentIntent's client secret, a CloudPRNT printer's MAC (its whole credential), and
 * our own Inngest event key. None of it belongs in a third party's error tracker, and
 * none of it helps anyone read an error.
 *
 * **Why this is needed on top of `DATA_COLLECTION`** (`sentry-config.ts`): that option
 * only governs what the SDK *collects* for the request itself. Four things reach an event
 * around it, each observed in the installed SDK (`sentry-pipeline.test.ts` sends them
 * through it):
 *
 * - **Outgoing-request breadcrumbs** keep the whole URL path — only userinfo and the
 *   query are filtered — and `inngest.send` POSTs to `https://inn.gs/e/<event key>`. So
 *   an `http` breadcrumb keeps its **origin only** (a relative URL, our own API, keeps its
 *   path): which dependency was called, never what was in the path.
 * - **`contexts.nextjs.request_path`**, which `captureRequestError` copies from Next's
 *   `request.path` unfiltered — query string included, and CloudPRNT's GET and DELETE
 *   carry `?mac=&token=`. Every `request_path` and `url` loses its query and fragment.
 * - **Console breadcrumbs** — every `console.warn`/`error` the process wrote — carry
 *   whatever was logged, a polling printer's serial among it.
 * - **Error messages**, where drizzle's `DrizzleQueryError` appends the bound parameters
 *   (`Failed query: <sql>\nparams: <values>`): on the order INSERT, a customer's name,
 *   phone, email and notes.
 *
 * Two passes over every field, because the data turns up in two shapes:
 *
 * - **By key**, wherever it sits in the event: a field named like contact data is
 *   replaced whole. Keys are compared with case, `_` and `-` removed, so `contactPhone`,
 *   `contact_phone` and `Contact-Phone` are one key. `name` counts only inside a
 *   `contact`/`customer` object — everywhere else in an event it names a runtime, an OS
 *   or an SDK, and removing those makes the event unreadable.
 * - **By pattern**, in every string: client secrets, the Inngest key in a `/e/<key>`
 *   path, a failed query's parameters, email addresses, E.164 and `(555) 123-4567`
 *   phones, and MACs (`00:11:62:aa:bb:cc`, dashed, or `%3A`-encoded) are replaced in
 *   place, leaving the rest of the sentence. A MAC is the shape of every Star printer's
 *   serial today; a future provider whose serials are not MACs needs its own pattern.
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

/** Keys whose value is a URL or a path, which keep everything but the query and fragment. */
const URL_KEYS = new Set(['url', 'requestpath'])

/**
 * Replaced in place inside any string, in this order. Secrets first, so an id inside one
 * is never half-matched; the query parameters before the phone and email patterns, so
 * the whole tail goes rather than a sentence with holes in it.
 */
const PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:pi|seti)_[A-Za-z0-9]+_secret_[A-Za-z0-9]+/g, '[client secret]'],
  // `inngest.send`'s URL is `<base>/e/<event key>`. Real keys are long; a legitimate
  // path with a short `/e/` segment is left alone.
  [/(\/e\/)[A-Za-z0-9_-]{16,}/g, '$1[inngest event key]'],
  // drizzle's `DrizzleQueryError`: the SQL is parameterised and worth keeping; the values
  // after it are the data. They may contain newlines (a customer's notes), so everything
  // to the end of the string goes.
  [/(\nparams: )[\s\S]*/g, '$1[redacted]'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
  [/\+[1-9]\d{6,14}/g, '[phone]'],
  [/\(\d{3}\)\s?\d{3}-\d{4}/g, '[phone]'],
  [/\b[0-9A-Fa-f]{2}([:-])[0-9A-Fa-f]{2}(?:\1[0-9A-Fa-f]{2}){4}\b/g, '[mac]'],
  [/\b[0-9A-Fa-f]{2}(?:%3[Aa][0-9A-Fa-f]{2}){5}\b/g, '[mac]'],
]

export function scrubEvent<T>(event: T): T {
  const scrubbed = scrub(event, null, new WeakSet())
  if (isRecord(scrubbed) && Array.isArray(scrubbed.breadcrumbs)) {
    scrubbed.breadcrumbs = scrubbed.breadcrumbs.map(originOnly)
  }
  return scrubbed as T
}

function scrub(value: unknown, parentKey: string | null, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    const text = scrubString(value)
    return parentKey !== null && URL_KEYS.has(normalise(parentKey)) ? withoutQuery(text) : text
  }
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

/**
 * An outgoing request's breadcrumb, reduced to which host was called, how, and what it
 * answered. The path is where a vendor puts keys and account ids (Inngest's event key,
 * Twilio's account SID); the query and fragment are gone already, and their split-out
 * `url.query` / `url.fragment` copies go too. A relative URL — the browser calling our
 * own API — keeps its path, which is ours and says which route it was.
 */
function originOnly(crumb: unknown): unknown {
  if (!isRecord(crumb) || !isRecord(crumb.data)) return crumb
  const outgoing = crumb.type === 'http' || crumb.category === 'http'
    || crumb.category === 'fetch' || crumb.category === 'xhr'
  if (!outgoing) return crumb

  const data: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(crumb.data)) {
    if (/^(url|http)\.(query|fragment)$/.test(key)) continue
    data[key] = key === 'url' && typeof value === 'string' ? origin(value) : value
  }
  return { ...crumb, data }
}

/** `https://inn.gs/e/<key>` → `https://inn.gs`; `/api/orders` stays `/api/orders`. */
function origin(url: string): string {
  const absolute = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)/i.exec(url)
  return absolute ? absolute[1] : withoutQuery(url)
}

function withoutQuery(url: string): string {
  return url.split(/[?#]/, 1)[0]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
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
