import { drizzle, type NeonDatabase } from 'drizzle-orm/neon-serverless'
import { Pool, neonConfig } from '@neondatabase/serverless'
import { sql } from 'drizzle-orm'
import { env } from '@/lib/env'
import * as schema from '@/db/schema'

/**
 * The tenant-scoped connection. Everything that touches a location's menus or
 * orders goes through `withLocation`; `db()` (neon-http) stays for the tables that
 * are not location-scoped — organizations, locations, memberships, hours.
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

function pool(): Pool {
  return (_pool ??= new Pool({ connectionString: env('DATABASE_URL') }))
}

function scopedDb(): ScopedDb {
  return (_db ??= drizzle(pool(), { schema }))
}

/** Releases the websocket pool. Tests call this in teardown; a server never does. */
export async function closeScopedPool(): Promise<void> {
  const p = _pool
  _pool = null
  _db = null
  if (p) await p.end()
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Runs `fn` inside one transaction scoped to a single location.
 *
 * `set_config('app.location_id', $1, true)` is `SET LOCAL` with a bind parameter —
 * `SET LOCAL` itself takes no parameters, and building that statement by hand is
 * how a location id becomes an injection. `true` is the LOCAL flag: the setting
 * dies with the transaction, so a pooled connection can never hand the next
 * caller the last caller's tenant.
 *
 * Every RLS policy in `drizzle/0007_rls_tenancy.sql` reads that GUC. A statement
 * outside this wrapper sees **no rows**, not all rows: `current_setting(...)`
 * returns NULL, and `location_id = NULL` is NULL, which is not true.
 */
export async function withLocation<T>(locationId: string, fn: (tx: ScopedTx) => Promise<T>): Promise<T> {
  // The policies cast the GUC to uuid, so anything else would fail deep inside an
  // unrelated query with a 22P02. Fail here, naming the argument.
  if (!UUID.test(locationId)) throw new Error(`withLocation: not a location id: ${JSON.stringify(locationId)}`)
  return scopedDb().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.location_id', ${locationId}, true)`)
    return fn(tx)
  })
}
