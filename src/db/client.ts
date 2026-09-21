import { drizzle } from 'drizzle-orm/neon-http'
import { neon } from '@neondatabase/serverless'
import { env } from '@/lib/env'
import * as schema from './schema'

/**
 * The stateless connection: one HTTPS round trip per statement, no session, no
 * transactions (`db().transaction()` throws).
 *
 * **Not for location-scoped data.** Menus, snapshots and orders are under RLS,
 * and the policies read a GUC that only survives inside a transaction — which
 * this driver cannot open. A read here returns zero rows and a write is refused
 * with 42501. Use `withLocation` from `@/repo/scoped` for those; `db()` is for
 * organizations, locations, memberships and the hours tables.
 */

let _db: ReturnType<typeof make> | null = null

function make() {
  return drizzle(neon(env('DATABASE_URL')), { schema })
}

export function db() {
  return (_db ??= make())
}
