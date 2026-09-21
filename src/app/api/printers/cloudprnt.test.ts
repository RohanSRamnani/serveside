import { describe, it, expect } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { printers, printJobs } from '@/db/schema'
import { withLocation } from '@/repo/scoped'
import { seedLocationWithMenu, seedPaidOrder, seedPrinter, seedPrintJob, macAddress } from '@/test/seed'

/**
 * The CloudPRNT endpoint, and the one route in this system with **no authentication
 * of any kind** — by protocol, not by omission. A thermal printer has no session, no
 * bearer token and no way to be given one; all it can present is the MAC address
 * burnt into it. So the trust boundary is the serial itself:
 *
 *   serial → the printer row → its location → `withLocation(that location)`
 *
 * Everything after the lookup is ordinary tenant-scoped code. Two properties make
 * that boundary hold, and both are asserted below rather than assumed:
 *
 * 1. **An unknown serial creates nothing.** Printers are provisioned by us. If this
 *    route upserted by MAC, anyone who can reach the URL could claim a location and
 *    start collecting another restaurant's tickets — with the customers' names and
 *    phone numbers on them.
 * 2. **A token is only redeemable in the context that polled for it.** The GET and
 *    the DELETE carry the printer's MAC too (Star sends it), so a job id lifted from
 *    one restaurant is a 404 at another — and a 404, not a 403, so the reply cannot
 *    be used to ask whether an id exists.
 */
const { POST, GET, DELETE } = await import('./cloudprnt/route')

const URL_BASE = 'https://serveside.test/api/printers/cloudprnt'

function poll(printerMAC: string, statusCode = '200 OK'): Promise<Response> {
  return POST(new Request(URL_BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ printerMAC, statusCode }),
  }))
}

function fetchJob(mac: string, token: string): Promise<Response> {
  const url = `${URL_BASE}?mac=${encodeURIComponent(mac)}&token=${encodeURIComponent(token)}&type=text/plain`
  return GET(new Request(url))
}

function confirmJob(mac: string, token: string, code = 'OK'): Promise<Response> {
  const url = `${URL_BASE}?mac=${encodeURIComponent(mac)}&token=${encodeURIComponent(token)}&code=${code}`
  return DELETE(new Request(url, { method: 'DELETE' }))
}

async function readPrinter(locationId: string, id: string) {
  return withLocation(locationId, async (tx) => {
    const [row] = await tx.select().from(printers).where(eq(printers.id, id))
    return row
  })
}

async function readJob(locationId: string, id: string) {
  return withLocation(locationId, async (tx) => {
    const [row] = await tx.select().from(printJobs).where(eq(printJobs.id, id))
    return row
  })
}

/** A restaurant with a printer and one paid order to print. */
async function kitchen() {
  const loc = await seedLocationWithMenu()
  const printer = await seedPrinter(loc.id)
  const { order } = await seedPaidOrder(loc.id)
  return { loc, printer, order }
}

describe('POST /api/printers/cloudprnt (the poll)', () => {
  it('answers a known printer with no work, and records the heartbeat', async () => {
    const { loc, printer } = await kitchen()
    expect(printer.lastSeenAt).toBeNull()

    const res = await poll(printer.serial)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ jobReady: false, mediaTypes: ['text/plain'] })

    // The heartbeat is not decoration: it is the only evidence that a printer in a
    // kitchen is still plugged in, and it drives the "your printer is offline" alert.
    const seen = await readPrinter(loc.id, printer.id)
    expect(seen.lastSeenAt).toBeInstanceOf(Date)
    expect(Date.now() - seen.lastSeenAt!.getTime()).toBeLessThan(60_000)
  })

  it('hands out the oldest queued job, then the payload, then takes the confirmation', async () => {
    const { loc, printer, order } = await kitchen()
    const older = await seedPrintJob(loc.id, order.id, '*** OLD1 ***\nfirst in')
    const newer = await seedPrintJob(loc.id, order.id, '*** NEW2 ***\nsecond in')
    // `created_at` defaults to now() and both land in the same millisecond often
    // enough that the tie has to be settled explicitly, or this test flickers.
    await withLocation(loc.id, (tx) => tx.execute(
      sql`update print_jobs set created_at = now() - interval '5 minutes' where id = ${older.id}`))

    const polled = await poll(printer.serial)
    const body = await polled.json() as { jobReady: boolean; mediaTypes: string[]; jobToken: string }
    expect(body.jobReady).toBe(true)
    expect(body.mediaTypes).toEqual(['text/plain'])
    // FIFO. A kitchen that prints the 7:05 order after the 7:20 one is a kitchen
    // plating them in that order too.
    expect(body.jobToken).toBe(older.id)

    const fetched = await fetchJob(printer.serial, body.jobToken)
    expect(fetched.status).toBe(200)
    expect(fetched.headers.get('content-type')).toMatch(/^text\/plain/)
    expect(await fetched.text()).toContain('OLD1')
    // `delivered` means the bytes left here — not that anything printed.
    expect((await readJob(loc.id, older.id)).status).toBe('delivered')

    const confirmed = await confirmJob(printer.serial, body.jobToken)
    expect(confirmed.status).toBe(200)
    const done = await readJob(loc.id, older.id)
    expect(done.status).toBe('confirmed')
    expect(done.confirmedAt).toBeInstanceOf(Date)

    // And the queue has moved on: the next poll offers the job behind it, never the
    // one just confirmed.
    const next = await poll(printer.serial)
    expect(await next.json()).toMatchObject({ jobReady: true, jobToken: newer.id })
  })

  it('goes quiet once the queue is confirmed', async () => {
    const { loc, printer, order } = await kitchen()
    const job = await seedPrintJob(loc.id, order.id, '*** ONE1 ***')

    const first = await poll(printer.serial)
    expect(await first.json()).toMatchObject({ jobReady: true, jobToken: job.id })
    await fetchJob(printer.serial, job.id)
    await confirmJob(printer.serial, job.id)

    const after = await poll(printer.serial)
    expect(await after.json()).toEqual({ jobReady: false, mediaTypes: ['text/plain'] })
  })

  it('will not confirm a ticket that was never collected, and re-confirms idempotently', async () => {
    // A `queued` job has never left here, so a confirmation of it is either a bug or
    // a ticket being burnt without printing — refuse, and leave it in the queue.
    const { loc, printer, order } = await kitchen()
    const job = await seedPrintJob(loc.id, order.id, '*** NEV1 ***')

    expect((await confirmJob(printer.serial, job.id)).status).toBe(404)
    expect((await readJob(loc.id, job.id)).status).toBe('queued')

    await poll(printer.serial)
    await fetchJob(printer.serial, job.id)
    expect((await confirmJob(printer.serial, job.id)).status).toBe(200)
    const first = await readJob(loc.id, job.id)

    // Star retries a confirmation it did not see acknowledged. The second one is the
    // same fact arriving twice, not a second print — 200, and the original time kept.
    expect((await confirmJob(printer.serial, job.id)).status).toBe(200)
    const again = await readJob(loc.id, job.id)
    expect(again.status).toBe('confirmed')
    expect(again.confirmedAt!.getTime()).toBe(first.confirmedAt!.getTime())
  })

  it('leaves a job that failed to print at delivered, so it shows up as stuck', async () => {
    // `code` is the printer's own verdict. A non-OK code means paper out, cover open
    // or a jam — the ticket did not come out, so it must not be marked confirmed and
    // quietly forgotten. It is not requeued either: a jammed printer would collect
    // and fail the same job forever.
    const { loc, printer, order } = await kitchen()
    const job = await seedPrintJob(loc.id, order.id, '*** JAM1 ***')
    await poll(printer.serial)
    await fetchJob(printer.serial, job.id)

    const res = await confirmJob(printer.serial, job.id, '40600000')
    expect(res.status).toBe(200)
    const stuck = await readJob(loc.id, job.id)
    expect(stuck.status).toBe('delivered')
    expect(stuck.confirmedAt).toBeNull()
  })
})

describe('the serial is the credential', () => {
  it('creates nothing at all for a serial it has never seen', async () => {
    // The whole reason this route does not upsert by MAC. If it did, anyone who can
    // reach the URL could register themselves as a printer and — once someone pointed
    // a location at them — start collecting a restaurant's tickets.
    const before = await db().execute(sql`select count(*)::int as n from printers`)
    const stranger = macAddress()

    const res = await poll(stranger)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ jobReady: false, mediaTypes: ['text/plain'] })

    const after = await db().execute(sql`select count(*)::int as n from printers`)
    expect((after.rows[0] as { n: number }).n).toBe((before.rows[0] as { n: number }).n)
    const planted = await db().execute(sql`select * from printer_lookup(${stranger})`)
    expect(planted.rows).toHaveLength(0)
  })

  it('never shows one restaurant the other one\'s queue', async () => {
    const a = await kitchen()
    const b = await kitchen()
    const jobA = await seedPrintJob(a.loc.id, a.order.id, '*** AAAA ***\nlocation A dinner')

    // B's printer polls. A has work; B does not. The scope comes from B's serial, so
    // there is no request B could make that would say otherwise.
    const polled = await poll(b.printer.serial)
    expect(await polled.json()).toEqual({ jobReady: false, mediaTypes: ['text/plain'] })

    // And B cannot redeem A's token even holding it: the GET carries B's MAC, which
    // opens B's scope, and RLS makes A's job simply not there.
    const stolen = await fetchJob(b.printer.serial, jobA.id)
    expect(stolen.status).toBe(404)
    expect(await stolen.text()).toBe('')
    expect((await readJob(a.loc.id, jobA.id)).status).toBe('queued')

    const confirmed = await confirmJob(b.printer.serial, jobA.id)
    expect(confirmed.status).toBe(404)
    expect((await readJob(a.loc.id, jobA.id)).status).toBe('queued')
  })

  it('404s a fetch that names no printer, or names one that does not exist', async () => {
    const { loc, printer, order } = await kitchen()
    const job = await seedPrintJob(loc.id, order.id, '*** ONE1 ***')

    // No MAC at all: there is no polling context to open, so there is nothing to
    // answer — an id alone is not a credential.
    expect((await GET(new Request(`${URL_BASE}?token=${job.id}`))).status).toBe(404)
    expect((await fetchJob(macAddress(), job.id)).status).toBe(404)
    // A malformed token would be a 22P02 from Postgres if it reached a query.
    expect((await fetchJob(printer.serial, 'not-a-uuid')).status).toBe(404)
    // A real uuid that is nobody's job reads exactly the same as one that is someone
    // else's: 404, empty body, no hint either way.
    expect((await fetchJob(printer.serial, '00000000-0000-4000-8000-000000000000')).status).toBe(404)

    expect((await readJob(loc.id, job.id)).status).toBe('queued')
  })

  it('refuses a poll that is not a CloudPRNT poll', async () => {
    const res = await POST(new Request(URL_BASE, { method: 'POST', body: 'not json' }))
    expect(res.status).toBe(400)
    // A well-formed poll with no MAC is a printer we cannot place, not a bad request.
    const noMac = await POST(new Request(URL_BASE, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"statusCode":"200 OK"}',
    }))
    expect(noMac.status).toBe(200)
    expect(await noMac.json()).toEqual({ jobReady: false, mediaTypes: ['text/plain'] })
  })
})

describe('printer_lookup, the one deliberate RLS bypass', () => {
  it('resolves a serial to ids and nothing else, without a scope', async () => {
    // The chicken-and-egg this function exists for: `printers` is RLS-policed, so an
    // unscoped read returns nothing — and the location that would scope the read is
    // the thing being looked up. SECURITY DEFINER is the doorway, and it is narrow on
    // purpose: one argument in, two ids out, no serial, no last_seen_at, no row.
    const { loc, printer } = await kitchen()

    const blind = await db().execute(sql`select id from printers where id = ${printer.id}`)
    expect(blind.rows).toHaveLength(0)

    const found = await db().execute(sql`select * from printer_lookup(${printer.serial})`)
    expect(found.rows).toEqual([{ printer_id: printer.id, location_id: loc.id }])
  })

  it('is not executable by the world', async () => {
    // A function is EXECUTE-to-PUBLIC by default, so the REVOKE in the migration is
    // load-bearing. This asserts the live branch matches the committed migration.
    const acl = await db().execute(sql`
      select coalesce(array_to_string(proacl, ' '), '') as acl
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'printer_lookup'`)
    const { acl: grants } = acl.rows[0] as { acl: string }
    expect(grants).toMatch(/app_user=X/)
    // `=X/` with no role before the `=` is the PUBLIC grant.
    expect(grants).not.toMatch(/(^|[ ,])=X/)
    // That it is SECURITY DEFINER at all, that its search_path is pinned, and that
    // it is the *only* such function in the database are asserted where they belong:
    // `src/repo/rls.test.ts`, next to the catalog of what RLS covers.
  })
})
