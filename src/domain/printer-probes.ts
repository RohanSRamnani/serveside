import { count, gt, lt, max, sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { printerProbeEvents } from '@/db/schema'

/**
 * The unknown-serial ledger: who knocked on the CloudPRNT door and turned out to be
 * nobody.
 *
 * It exists for one signal — **serial enumeration**. That route is unauthenticated by
 * protocol and the serial is the whole credential, so guessing one is the attack, and a
 * spread of *distinct* unknown serials in a short window is the only sign it leaves. A
 * genuinely unknown serial is one mis-provisioned printer repeating one MAC all
 * afternoon.
 *
 * It lives here rather than in the route or the cron because **both** touch it and they
 * must agree on the same two numbers: the route refuses to record past the threshold
 * the cron alerts at, so a cap and an alarm tuned apart cannot happen. Importing the
 * cron into the route would also drag the whole unsnooze/menu graph into the bundle a
 * thermal printer polls.
 *
 * Unscoped `db()` throughout, on purpose: a row here belongs to **no** location — that
 * is what `printer_lookup` returning nothing means — which is why the table is exempt
 * from RLS (`drizzle/0016` argues it).
 */

/** How far back the burst count reaches. */
export const PROBE_BURST_WINDOW_MS = 10 * 60_000

/**
 * How many **distinct** unknown serials inside that window mean somebody is sweeping —
 * and, equally, the point at which this table stops growing.
 */
export const PROBE_BURST_THRESHOLD = 20

/**
 * How long a probe row is kept. Long enough to look at the morning after and to hold a
 * whole night's sweep; short enough that the table is a rolling window rather than a
 * permanent record of every serial ever guessed.
 */
export const PROBE_RETENTION_MS = 24 * 60 * 60_000

/**
 * Writes down that a serial nobody owns came knocking.
 *
 * **Two caps, because this is a write an unauthenticated stranger triggers.**
 *
 * 1. *One row per serial*, upserted. A row per request would be unbounded growth an
 *    attacker controls; this way a mis-provisioned printer polling every three seconds
 *    for a week is one row, and `polls` is what says so.
 * 2. *No new serials once the window is already over threshold.* This is the one that
 *    matters against a real sweep: the MAC space is tens of millions, and a row each
 *    would be a durable, attacker-chosen table that then has to be cleaned up in a
 *    migration written under pressure. Past the threshold the alarm is already earned
 *    and another serial adds nothing — so the table simply stops listening. An existing
 *    serial is still bumped (the `or exists`), because that costs no growth at all.
 *
 *    The cap refills by itself: rows age out of the ten-minute window, the count drops,
 *    and recording resumes. So a sustained sweep costs at most about a threshold's
 *    worth of rows per window — and the 24-hour retention takes those away too.
 *
 * The cost of the cap, stated where it can be read: `serials` becomes a **floor rather
 * than a measurement** once it saturates, which is why the alert says "at least".
 *
 * One statement, so the count and the insert cannot interleave into a different answer.
 */
export async function recordProbe(serial: string, now = new Date()): Promise<void> {
  const since = new Date(now.getTime() - PROBE_BURST_WINDOW_MS).toISOString()
  await db().execute(sql`
    insert into printer_probe_events (serial)
    select ${serial}
    where (
      select count(*) from printer_probe_events where last_seen_at > ${since}::timestamptz
    ) <= ${PROBE_BURST_THRESHOLD}
      or exists (select 1 from printer_probe_events where serial = ${serial})
    on conflict (serial) do update
      set last_seen_at = now(), polls = printer_probe_events.polls + 1
  `)
}

/** How many distinct serials are in the window, and when one of them last raised an alarm. */
export async function probeWindow(now: Date): Promise<{ serials: number; lastAlertedAt: Date | null }> {
  // Aggregated rather than read: the only two facts wanted are how many, and whether
  // anybody has already been told.
  const [window] = await db()
    .select({ serials: count(), lastAlertedAt: max(printerProbeEvents.alertedAt) })
    .from(printerProbeEvents)
    .where(gt(printerProbeEvents.lastSeenAt, new Date(now.getTime() - PROBE_BURST_WINDOW_MS)))
  return { serials: window?.serials ?? 0, lastAlertedAt: window?.lastAlertedAt ?? null }
}

/**
 * Stamps the rows that made the count. They **are** the alert, so marking them is the
 * record that it went out — and the hour of quiet that follows.
 */
export async function markProbesAlerted(now: Date): Promise<void> {
  await db().update(printerProbeEvents)
    .set({ alertedAt: now })
    .where(gt(printerProbeEvents.lastSeenAt, new Date(now.getTime() - PROBE_BURST_WINDOW_MS)))
}

/**
 * Drops probe rows older than the retention window, and reports how many.
 *
 * Without this the table is append-only forever, which is exactly the shape nobody
 * wants on a table a stranger can add to. Run from the heartbeat cron, so the cleanup
 * happens on the same five-minute beat as the alarm that reads it and never becomes a
 * migration somebody has to write during an incident.
 *
 * `returning` is safe here precisely because the cap above exists: after the first run
 * this only ever deletes what aged out in the last five minutes, which is bounded by
 * the threshold.
 */
export async function pruneProbes(before: Date): Promise<number> {
  const gone = await db().delete(printerProbeEvents)
    .where(lt(printerProbeEvents.lastSeenAt, before))
    .returning({ id: printerProbeEvents.id })
  return gone.length
}
