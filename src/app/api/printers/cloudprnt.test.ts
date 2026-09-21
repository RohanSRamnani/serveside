import { describe, it, expect, vi } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { neon } from '@neondatabase/serverless'
import { db } from '@/db/client'
import { printers, printJobs, printerProbeEvents } from '@/db/schema'
import { withLocation } from '@/repo/scoped'
import {
  seedLocationWithMenu, seedPaidOrder, seedPrinter, seedPrintJob, macAddress, quietProbeWindow,
} from '@/test/seed'
import { PROBE_BURST_THRESHOLD } from '@/domain/printer-probes'

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
 * 1. **An unknown serial creates no printer.** Printers are provisioned by us. If this
 *    route upserted onto `printers` by MAC, anyone who can reach the URL could claim a
 *    location and start collecting another restaurant's tickets — with the customers'
 *    names and phone numbers on them. (It does write one capped `printer_probe_events`
 *    row, which has no location and no path into `printers`; that is the enumeration
 *    alarm's only input, and the tests below pin both halves.)
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

/**
 * A count of every printer row on the branch, taken as the **owner**.
 *
 * The only privileged connection in this suite, and it exists to prove a negative
 * that RLS would otherwise make unprovable. "The route created no printer" is a
 * statement about rows we are not allowed to see: asked as `app_user` it answers
 * zero whether or not a row was written, so the assertion would pass for a route
 * that auto-registers. Asked as the owner it is the real number.
 *
 * **Not a general escape hatch.** Nothing else in this repo's tests connects as the
 * owner, and nothing else should: every other assertion here is about what the
 * application can see, which is exactly what `app_user` answers. If this connection
 * is ever the thing that makes a test pass, the test is wrong.
 */
async function countPrinters(): Promise<number> {
  const owner = neon(process.env.MIGRATION_DATABASE_URL!)
  const [row] = await owner`select count(*)::int as n from printers` as { n: number }[]
  return row.n
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
    //
    // The count runs on the **owner** connection. Counting through `db()` would be
    // worse than useless here: `printers` is RLS-policed and `db()` carries no scope,
    // so it reads 0 before and 0 after whatever the route does, and the assertion
    // passes for a route that auto-registers just as happily as for one that does not.
    // A test that cannot fail is not evidence.
    const existing = await kitchen()
    const before = await countPrinters()
    const stranger = macAddress()

    const res = await poll(stranger)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ jobReady: false, mediaTypes: ['text/plain'] })

    expect(await countPrinters()).toBe(before)
    const planted = await db().execute(sql`select * from printer_lookup(${stranger})`)
    expect(planted.rows).toHaveLength(0)

    // And it does not touch the printers it *does* know. A heartbeat written on an
    // unrecognised poll would mean a dead printer looks alive for as long as someone
    // is knocking — which is precisely when the offline alert matters most.
    expect((await readPrinter(existing.loc.id, existing.printer.id)).lastSeenAt).toBeNull()
  })

  it('counts an unprovisioned serial, one row however many times it knocks', async () => {
    // The window has to be quiet first, and not for tidiness: the route stops
    // recording new serials once the burst window is over threshold, so a file that
    // ran before this one and left twenty fresh probes behind would make this fail for
    // a reason that has nothing to do with the route. `seed.ts` explains the sharing.
    await quietProbeWindow()
    // The **one** thing an unknown serial now writes, and it is nothing like an
    // auto-registration: a row with no `location_id`, no path into `printers`, and
    // nothing in it but a serial that belongs to nobody. It exists because serial
    // enumeration is the residual attack on this route and a spread of distinct
    // unknown serials is the only signal it gives off — and because a serverless
    // counter in memory is per-instance, per-cold-start, and therefore never over any
    // threshold.
    //
    // Upserted rather than appended, which is what bounds it: this path is
    // unauthenticated, so a row per request would be unbounded growth an attacker
    // controls. One mis-provisioned printer knocking all afternoon is one row.
    const before = await countPrinters()
    const stranger = macAddress()

    await poll(stranger)
    await poll(stranger)

    const [probe] = await db().select().from(printerProbeEvents)
      .where(eq(printerProbeEvents.serial, stranger))
    expect(probe).toBeDefined()
    expect(probe.polls).toBe(2)
    expect(probe.alertedAt).toBeNull()
    expect(Date.now() - probe.lastSeenAt.getTime()).toBeLessThan(60_000)

    // Still not a printer, and still not anybody's: the count that would catch an
    // auto-registration is unchanged, and the lookup still refuses the serial.
    expect(await countPrinters()).toBe(before)
    expect((await db().execute(sql`select * from printer_lookup(${stranger})`)).rows).toHaveLength(0)
  })

  it('stops writing new rows once a sweep is already obvious', async () => {
    // **The cap that stops this being a durable write an attacker chooses the size
    // of.** The MAC space a sweep walks is tens of millions; a row per guess would be
    // tens of millions of rows in a table nothing had a plan for. Past the alerting
    // threshold the alarm is earned and another serial adds nothing, so the route
    // stops recording — and the cap refills by itself as rows age out of the window.
    await quietProbeWindow()
    await db().insert(printerProbeEvents).values(
      Array.from({ length: PROBE_BURST_THRESHOLD + 1 }, () => ({ serial: macAddress() })),
    )
    const stranger = macAddress()

    // The printer still gets the same answer it always did — the cap is invisible from
    // the outside, which is the point: nothing about the reply says what we know.
    const res = await poll(stranger)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ jobReady: false, mediaTypes: ['text/plain'] })

    expect(await db().select().from(printerProbeEvents)
      .where(eq(printerProbeEvents.serial, stranger))).toHaveLength(0)
  })

  it('records nothing for a serial that is not shaped like one', async () => {
    // The clamp runs first, so the probe table can only ever hold short, boring
    // tokens — the same guarantee the log line has. Otherwise a megabyte of JSON in
    // `printerMAC` would be a megabyte in a durable table, on every request.
    const before = await db().select({ id: printerProbeEvents.id }).from(printerProbeEvents)
    await poll('x'.repeat(65))
    await poll('00 11 62')
    expect(await db().select({ id: printerProbeEvents.id }).from(printerProbeEvents))
      .toHaveLength(before.length)
  })

  it('records nothing for a printer it knows', async () => {
    const { printer } = await kitchen()
    await poll(printer.serial)
    const rows = await db().select().from(printerProbeEvents)
      .where(eq(printerProbeEvents.serial, printer.serial))
    expect(rows).toHaveLength(0)
  })

  it('drops a serial that is not shaped like one before it reaches a log line', async () => {
    // The clamp's whole effect is on what gets *logged*, because an unknown serial is
    // answered `jobReady: false` either way — so asserting the response would be
    // asserting nothing. What it prevents: a megabyte of JSON in `printerMAC` is a
    // megabyte in the log on every request (a log flood with no rate limit in front of
    // it), and newlines in it let a caller write their own entries into an incident
    // timeline. Both are only visible at `console.warn`.
    const { loc, printer, order } = await kitchen()
    const job = await seedPrintJob(loc.id, order.id, '*** CLM1 ***')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      for (const bogus of ['x'.repeat(65), 'aa:bb\ncc:dd', "00:11:62'; drop table printers; --", '', '00 11 62']) {
        const res = await poll(bogus)
        expect(res.status, `serial ${JSON.stringify(bogus.slice(0, 20))}`).toBe(200)
        expect(await res.json()).toEqual({ jobReady: false, mediaTypes: ['text/plain'] })
        // Never queried, never logged — it did not look like a serial, so it was not
        // treated as one at any point.
        expect(warn, `${JSON.stringify(bogus.slice(0, 20))} reached a log line`).not.toHaveBeenCalled()
      }

      // The positive control: a well-shaped serial we simply do not know *is* worth a
      // line, and the row beside it is what the enumeration alarm counts.
      const unknown = macAddress()
      await poll(unknown)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0].join(' ')).toContain(unknown)

      // A status code is attacker-controlled too, and also ends up in a log line.
      warn.mockClear()
      await poll(printer.serial, `40600000 ${'z'.repeat(500)}\nprinter provisioned: attacker`)
      const logged = warn.mock.calls[0].join(' ')
      expect(logged).not.toMatch(/\n/)
      expect(logged.length).toBeLessThan(200)
    } finally {
      warn.mockRestore()
    }

    // A GET or DELETE carrying a malformed MAC is no different: no context to open.
    expect((await fetchJob('x'.repeat(65), job.id)).status).toBe(404)
    expect((await confirmJob('aa:bb\ncc', job.id)).status).toBe(404)

    // And the real printer still works, so the clamp rejects shapes, not everything.
    expect(await (await poll(printer.serial)).json()).toMatchObject({ jobReady: true, jobToken: job.id })
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

describe('the poll runs on an index', () => {
  it('has the partial index the queue read depends on', async () => {
    // Every printer on the platform runs one query against `print_jobs` forever, every
    // few seconds, and nothing ever prunes the table — it is the record of what was
    // printed. Without this index that poll becomes a sequential scan over a year of
    // tickets to discover that nothing is waiting, and the cost compounds with every
    // order ever taken. Asserted rather than assumed because an index is invisible
    // until it is missing: EXPLAIN on a near-empty test table would pick a seq scan
    // either way, so what is pinned is that the index is really on the branch, with
    // the predicate that matches the query.
    const idx = await db().execute(sql`
      select indexdef from pg_indexes
      where schemaname = 'public' and tablename = 'print_jobs' and indexname = 'print_jobs_queued_idx'`)
    expect(idx.rows).toHaveLength(1)
    const { indexdef } = idx.rows[0] as { indexdef: string }
    // location_id leads, because RLS adds that equality to every statement.
    expect(indexdef).toMatch(/\(location_id, created_at\)/)
    // Partial, so it holds the handful of queued jobs rather than every ticket ever.
    expect(indexdef).toMatch(/WHERE \(status = 'queued'/)
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
