import { drizzle, type NeonDatabase } from 'drizzle-orm/neon-serverless'
import { Pool, neonConfig } from '@neondatabase/serverless'
import { sql } from 'drizzle-orm'
import { env } from '@/lib/env'
import * as schema from '@/db/schema'

/**
 * The tenant-scoped connection. Everything that touches a location's menus,
 * orders or hours goes through `withLocation`; `db()` (neon-http) stays for the
 * tables that carry no `location_id` to scope to at all — `organizations`,
 * `locations`, `memberships`, `webhook_events`, `printer_probe_events`. Hours
 * (`business_hours`, `holiday_closures`, `order_pauses`) moved under RLS in
 * migration 0009 — an unscoped read of them now returns zero rows, same as
 * menus and orders.
 *
 * **Why a second driver at all.** RLS reads the current location out of a session
 * GUC, and a GUC only survives inside a transaction (`SET LOCAL`). The neon-http
 * driver is stateless — one HTTPS round trip per statement, no session, no
 * transactions (`db().transaction()` throws) — so it can never carry the scope.
 * The websocket Pool can, which is the whole reason it is here.
 *
 * Node 22 ships a global `WebSocket`, so the `ws` package is not a dependency.
 * Anything older would need `neonConfig.webSocketConstructor = require('ws')`.
 */
if (!neonConfig.webSocketConstructor && typeof globalThis.WebSocket !== 'undefined') {
  neonConfig.webSocketConstructor = globalThis.WebSocket as unknown as typeof neonConfig.webSocketConstructor
}

type ScopedDb = NeonDatabase<typeof schema>

/**
 * The handle a scoped callback gets: a drizzle transaction with the location GUC
 * already set. Exported because the repos and every caller downstream type
 * against it — Tasks 8, 12 and 13 all take one of these.
 */
export type ScopedTx = Parameters<Parameters<ScopedDb['transaction']>[0]>[0]

let _pool: Pool | null = null
let _db: ScopedDb | null = null
let _roleCheck: Promise<void> | null = null

function pool(): Pool {
  return (_pool ??= new Pool({ connectionString: env('DATABASE_URL') }))
}

function scopedDb(): ScopedDb {
  return (_db ??= drizzle(pool(), { schema }))
}

/**
 * Every policy in `drizzle/0008_rls_tenancy.sql` is a no-op against a role that
 * owns the tables, is a superuser, or has BYPASSRLS — and the failure is silent:
 * nothing errors, every query simply returns every restaurant's rows. So the check
 * happens here, once, the first time a scoped transaction opens.
 *
 * `scripts/create-app-user.mjs` makes the same assertion before it will write an
 * env file. This is the one that catches the env file being edited afterwards.
 */
async function assertUnprivilegedRole(): Promise<void> {
  const { rows: [row] } = await pool().query(`
    SELECT current_user AS who,
           (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_super,
           (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypasses_rls,
           (SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user) AS owns`)
  const reasons: string[] = []
  if (row.is_super) reasons.push('it is a superuser')
  if (row.bypasses_rls) reasons.push('it has BYPASSRLS')
  if (Number(row.owns) > 0) reasons.push(`it owns ${row.owns} tables in public (RLS does not bind a table's owner)`)
  if (reasons.length === 0) return
  throw new Error(
    `DATABASE_URL connects as "${row.who}", which bypasses row-level security: ${reasons.join('; ')}. `
    + 'Every tenancy policy is silently inert for this role. Point DATABASE_URL at app_user '
    + '(npm run db:app-user) and keep the owner in MIGRATION_DATABASE_URL, which drizzle-kit and '
    + "scripts/seed-kashi.ts's admin connection read — nothing else may.",
  )
}

/**
 * The websocket pool `withLocation` runs on — for teardown, health checks, and the
 * one test that has to prove `SET LOCAL` does not outlive its transaction, which can
 * only be observed on the backend `withLocation` itself used.
 *
 * Not a query handle for application code. A raw query here carries no scope and so
 * sees nothing; everything tenant-scoped goes through `withLocation`.
 */
export function scopedPool(): Pool {
  return pool()
}

/** Releases the websocket pool. Tests call this in teardown; a server never does. */
export async function closeScopedPool(): Promise<void> {
  const p = _pool
  _pool = null
  _db = null
  _roleCheck = null
  if (p) await p.end()
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Shared with anything that takes an id from outside and puts it in a query.
 * Postgres raises 22P02 on a malformed uuid, which inside a transaction poisons
 * every statement after it — so the check belongs in front of the query, not around
 * it. `createOrder` uses this on every id in a request body.
 */
export function isUuid(value: string): boolean {
  return UUID.test(value)
}

/**
 * Runs `fn` inside one transaction scoped to a single location.
 *
 * `set_config('app.location_id', $1, true)` is `SET LOCAL` with a bind parameter —
 * `SET LOCAL` itself takes no parameters, and building that statement by hand is
 * how a location id becomes an injection. `true` is the LOCAL flag: the setting
 * dies with the transaction, so a pooled connection can never hand the next
 * caller the last caller's tenant.
 *
 * Every RLS policy in `drizzle/0008_rls_tenancy.sql` reads that GUC. A statement
 * outside this wrapper sees **no rows**, not all rows: `current_setting(...)`
 * returns NULL, and `location_id = NULL` is NULL, which is not true.
 */
export async function withLocation<T>(locationId: string, fn: (tx: ScopedTx) => Promise<T>): Promise<T> {
  // The policies cast the GUC to uuid, so anything else would fail deep inside an
  // unrelated query with a 22P02. Fail here, naming the argument.
  if (!isUuid(locationId)) throw new Error(`withLocation: not a location id: ${JSON.stringify(locationId)}`)
  // Cached, so it is one extra round trip per process, not per transaction. Cleared
  // on failure so a transient connection error does not poison every later call.
  _roleCheck ??= assertUnprivilegedRole().catch((err) => { _roleCheck = null; throw err })
  await _roleCheck
  return scopedDb().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.location_id', ${locationId}, true)`)
    return fn(tx)
  })
}
