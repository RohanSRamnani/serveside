import { drizzle } from 'drizzle-orm/neon-http'
import { neon } from '@neondatabase/serverless'
import { env } from '@/lib/env'
import * as schema from './schema'

let _db: ReturnType<typeof make> | null = null

function make() {
  return drizzle(neon(env('DATABASE_URL')), { schema })
}

export function db() {
  return (_db ??= make())
}
