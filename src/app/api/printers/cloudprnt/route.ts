import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { printers, printJobs } from '@/db/schema'
import { withLocation, isUuid } from '@/repo/scoped'

/**
 * Star CloudPRNT. The kitchen printer polls **us**.
 *
 * That direction is the whole reason this protocol was chosen: a restaurant has a
 * consumer router and nobody to open a port on it, so nothing can push a ticket in.
 * The printer opens an outbound connection every few seconds and asks whether there
 * is work. Three verbs, one URL:
 *
 *   POST    the poll. `{ printerMAC, statusCode }` in, `{ jobReady, mediaTypes,
 *           jobToken? }` out, and the heartbeat recorded either way.
 *   GET     `?mac=&token=` — the job payload, as `text/plain`. The job becomes
 *           `delivered`: the bytes left here, which is not the same as printed.
 *   DELETE  `?mac=&token=&code=OK` — the printer's verdict. `OK` confirms;
 *           anything else means it did not come out.
 *
 * **This route is unauthenticated, by protocol rather than by oversight.** A thermal
 * printer has no session and no way to be given one; all it can present is the MAC
 * burnt into it. So the serial *is* the credential, and the trust boundary is one
 * step wide:
 *
 *     serial → `printer_lookup` → (printer id, location id) → withLocation(location)
 *
 * `printer_lookup` is a SECURITY DEFINER function and the only RLS bypass in this
 * codebase — `drizzle/0012_printer_lookup.sql` argues why that is safe and why the
 * alternatives are not. Everything past the lookup is ordinary scoped code, policed
 * by RLS exactly like the rest of the app.
 *
 * Two rules follow from that, and neither is negotiable:
 *
 * - **An unknown serial creates nothing.** No upsert, no auto-registration. Printers
 *   are provisioned by us. A route that registered a printer on first sight would let
 *   anyone who can reach this URL claim a location and start collecting another
 *   restaurant's tickets, names and phone numbers included.
 * - **A token is only redeemable in the context that polled for it.** The GET and the
 *   DELETE carry the MAC too (Star sends it), so a job id lifted from one restaurant
 *   is a 404 at another — and a 404 with an empty body, never a 403, so the reply
 *   cannot be used to ask whether an id exists.
 *
 * **The residual attack, named rather than left to be discovered: serial enumeration.**
 * If the serial is the credential then guessing one is the whole attack, and a MAC is
 * a poor secret. The OUI is public (`00:11:62` is Star), which leaves ~24 bits, and
 * vendors burn MACs sequentially — so a range around a known unit is a far smaller
 * search than 24 bits suggests. A hit is not a nuisance: the attacker collects that
 * kitchen's next ticket, with the customer's name and phone number on it, and can then
 * DELETE it `code=OK` so the ticket never prints and nobody is told.
 *
 * What is done about it here is only what belongs here: the serial is clamped to a
 * plausible shape before it is used or logged (below), so an unknown serial costs one
 * indexed lookup and one bounded log line and nothing else.
 *
 * TODO(task-14): the actual mitigations are rate-limiting and alerting, and they are
 * Task 14's — it already owns the printer-health alerting that reads `lastSeenAt`.
 * Two obligations, neither optional:
 *   1. Throttle polls per source (and per unknown serial) — an enumeration sweep is
 *      thousands of requests a minute; a real printer polls every few seconds.
 *   2. Alert on an **unprovisioned-serial burst**. A genuine unknown serial is a
 *      mis-provisioned printer at install time: one MAC, repeating. A spread of
 *      distinct unknown serials is someone sweeping, and it is the only signal we get.
 */

/** The only thing we render. Star uses this to pick its print path. */
const MEDIA_TYPES = ['text/plain'] as const

/**
 * All `printer_lookup` will tell us, and all this route needs: which printer, and
 * whose. Not the `Printer` row from the schema — nothing here reads one.
 */
type PrinterRef = { printerId: string; locationId: string }

/**
 * What a printer serial is allowed to look like, checked **before** the value is
 * queried with or written to a log.
 *
 * A MAC is `00:11:62:aa:bb:cc`; the column is `text` because the next provider's
 * serial will not be a MAC, so this is deliberately wider than one vendor's format —
 * alphanumerics and the three separators anyone uses, bounded at 64 characters. It is
 * not an attempt to validate a MAC. It is an attempt to make sure that whatever
 * reaches `printer_lookup` and `console.warn` is a short, boring token.
 *
 * Two things it closes. A megabyte of JSON string in `printerMAC` would otherwise be
 * a megabyte in the log on every request — a log-flood with no rate limit in front of
 * it. And a serial containing newlines would let an attacker write their own lines
 * into our logs, which is how a forged "printer provisioned" entry appears in an
 * incident timeline.
 */
const SERIAL = /^[A-Za-z0-9:_.-]{1,64}$/

/** The serial from a request, or null if it is not one. Never throws; never logs. */
function serialFrom(value: unknown): string | null {
  return typeof value === 'string' && SERIAL.test(value) ? value : null
}

export async function POST(req: Request): Promise<Response> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    // Not a CloudPRNT poll at all. A real printer always sends JSON, so this is
    // someone else — say so plainly rather than pretending to be a print queue.
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const poll = body as { printerMAC?: unknown; statusCode?: unknown } | null
  // Clamped first: everything below either queries with this value or logs it.
  const serial = serialFrom(poll?.printerMAC)
  const printer = serial ? await lookupPrinter(serial) : null
  // A well-formed poll we cannot place is not a bad request — it is a printer we do
  // not know, and the honest answer is "no work for you". Logged, not written down:
  // this is the line that would be an auto-registration if we let it be.
  if (!printer) {
    if (serial) console.warn('[cloudprnt] poll from an unprovisioned serial', serial)
    return noJob()
  }

  // The printer reports its own health on every poll — `200 OK`, or a code for cover
  // open, paper out, a jam. There is nowhere to store it (no column, and Task 14's
  // alert reads `lastSeenAt`), so it is logged when it is not OK rather than dropped.
  // Bounded and stripped for the same reason the serial is: it ends up in a log line,
  // and a status code with newlines in it would let a printer write its own entries.
  if (typeof poll?.statusCode === 'string' && !poll.statusCode.startsWith('200')) {
    console.warn('[cloudprnt] printer', serial, 'reports', poll.statusCode.replace(/\s+/g, ' ').slice(0, 64))
  }

  const jobToken = await withLocation(printer.locationId, async (tx) => {
    // The heartbeat, recorded whether or not there is work: it is the only evidence
    // that a printer in a kitchen is still plugged in, and a poll that found nothing
    // is exactly as good a sign of life as one that found a ticket.
    await tx.update(printers).set({ lastSeenAt: new Date() }).where(eq(printers.id, printer.printerId))

    // Oldest first — a kitchen that prints the 7:05 order after the 7:20 one plates
    // them in that order too. No location filter: the scope is the filter (RLS), and
    // writing it twice would hide the day RLS stops working.
    //
    // Known limit, named rather than discovered: two printers at one location would
    // both be offered this job, and both would print it. The product is one printer
    // per location; a second one needs `print_jobs` to carry the printer it is for.
    const [job] = await tx.select({ id: printJobs.id }).from(printJobs)
      .where(eq(printJobs.status, 'queued'))
      .orderBy(asc(printJobs.createdAt), asc(printJobs.id))
      .limit(1)
    return job?.id
  })

  return jobToken
    ? Response.json({ jobReady: true, mediaTypes: MEDIA_TYPES, jobToken })
    : noJob()
}

/**
 * The payload, and the job marked `delivered` in the same statement — an
 * `UPDATE ... RETURNING` rather than a read followed by a write, so there is no
 * window in which two collections of the same ticket both look like the first.
 *
 * A `confirmed` job is **not** served again: the printer has already said it came
 * out, and handing the bytes back would put a second copy of someone's dinner on the
 * pass. A `delivered` one is, because that is a retry after a print that failed.
 */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const printer = await pollingContext(url)
  const token = url.searchParams.get('token')
  if (!printer || !token || !isUuid(token)) return notFound()

  const payload = await withLocation(printer.locationId, async (tx) => {
    const [job] = await tx.update(printJobs)
      .set({ status: 'delivered' })
      .where(and(eq(printJobs.id, token), inArray(printJobs.status, ['queued', 'delivered'])))
      .returning({ payload: printJobs.payload })
    return job?.payload
  })
  if (payload === undefined) return notFound()

  return new Response(payload, {
    status: 200,
    headers: {
      // `charset=utf-8` is load-bearing: the ticket's `2× Butter Chicken` is the one
      // non-ASCII character on it, and a printer left to guess would print `2Ã—`.
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/**
 * The printer's verdict on a ticket it collected.
 *
 * `code=OK` confirms it. Anything else — paper out, cover open, a jam — means the
 * ticket did not come out, and the job stays at `delivered`: visible as stuck, which
 * is the state an owner phones about. It is deliberately **not** requeued, because a
 * jammed printer would then collect and fail the same job forever and never reach the
 * orders behind it.
 */
export async function DELETE(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const printer = await pollingContext(url)
  const token = url.searchParams.get('token')
  if (!printer || !token || !isUuid(token)) return notFound()
  const code = url.searchParams.get('code')
  const printed = code === 'OK'

  const found = await withLocation(printer.locationId, async (tx) => {
    if (!printed) {
      // Still scoped, still RLS-filtered — the point of the read is to tell a real
      // job that failed from a token that was never ours, which is a 404 either way
      // to the caller but a very different line in a log.
      const [job] = await tx.select({ id: printJobs.id }).from(printJobs)
        .where(eq(printJobs.id, token)).limit(1)
      return job !== undefined
    }
    // Only a job that was actually **collected** can be confirmed. A `queued` one has
    // never left here, so a confirmation of it is either a bug or someone burning a
    // ticket without printing it; refusing leaves it in the queue to be offered again.
    // `confirmed` is allowed through so a retried DELETE is idempotent rather than a
    // rude 404, and `coalesce` keeps the *first* confirmation time — the second
    // delivery of the same fact is not a second print.
    const [job] = await tx.update(printJobs)
      .set({ status: 'confirmed', confirmedAt: sql`coalesce(${printJobs.confirmedAt}, now())` })
      .where(and(eq(printJobs.id, token), inArray(printJobs.status, ['delivered', 'confirmed'])))
      .returning({ id: printJobs.id })
    return job !== undefined
  })
  if (!found) return notFound()

  if (!printed) console.warn('[cloudprnt] printer', printer.printerId, 'failed to print job', token, 'code', code)
  // Star ignores the body; 200 is the whole answer, and it is what stops the printer
  // re-sending the confirmation.
  return new Response(null, { status: 200 })
}

/**
 * The scope for a GET or a DELETE.
 *
 * Star puts the MAC on those requests as well as on the poll, which is what makes a
 * job token redeemable only by the printer that was offered it. `printerMAC` is
 * accepted as an alias purely so the query string and the POST body do not disagree
 * about the name of the same thing.
 */
async function pollingContext(url: URL): Promise<PrinterRef | null> {
  const serial = serialFrom(url.searchParams.get('mac') ?? url.searchParams.get('printerMAC'))
  return serial ? lookupPrinter(serial) : null
}

/**
 * Serial → ids, through the one SECURITY DEFINER function in this codebase.
 *
 * `db()` is the stateless driver and carries no scope, which is exactly right here:
 * there is no location to scope to yet — resolving one is the point. A plain SELECT
 * on `printers` from this connection returns nothing, by design.
 */
async function lookupPrinter(serial: string): Promise<PrinterRef | null> {
  const { rows } = await db().execute(sql`select printer_id, location_id from printer_lookup(${serial})`)
  const row = rows[0] as { printer_id: string; location_id: string } | undefined
  return row ? { printerId: row.printer_id, locationId: row.location_id } : null
}

function noJob(): Response {
  return Response.json({ jobReady: false, mediaTypes: MEDIA_TYPES })
}

/**
 * Empty, always. A body here would be the difference between "no such job" and "not
 * your job", and on an unauthenticated route that difference is an oracle for asking
 * whether a given id exists.
 */
function notFound(): Response {
  return new Response(null, { status: 404 })
}
