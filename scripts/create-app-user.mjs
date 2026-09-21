#!/usr/bin/env node
/**
 * Gives `app_user` a password and points an env file's DATABASE_URL at it.
 *
 * Run once per Neon branch, straight after `0008_rls_tenancy.sql` migrates. The
 * migration creates the role but cannot set its password: drizzle-kit does not
 * parameterise migration SQL, and a literal password in a committed .sql file is a
 * leaked credential. So the password is set here, from the environment, and never
 * printed — not to stdout, not to the shell history, not into git.
 *
 *   node scripts/create-app-user.mjs                 # .env.test
 *   ENV_FILE=.env.local node scripts/create-app-user.mjs
 *   APP_USER_PASSWORD=... node scripts/create-app-user.mjs   # else one is generated
 *
 * Afterwards the env file holds two connection strings and the split matters:
 *
 *   MIGRATION_DATABASE_URL  the owner — owns the tables, bypasses RLS, runs drizzle-kit
 *   DATABASE_URL            app_user — owns nothing, RLS binds it, everything else uses it
 *
 * Re-running is safe: it rotates the password and rewrites both lines.
 */
import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { config as loadEnv } from 'dotenv'
import { Pool, neonConfig } from '@neondatabase/serverless'

const ENV_FILE = process.env.ENV_FILE ?? '.env.test'
const ROLE = 'app_user'

if (!neonConfig.webSocketConstructor && typeof globalThis.WebSocket !== 'undefined') {
  neonConfig.webSocketConstructor = globalThis.WebSocket
}

function die(message) {
  console.error(`create-app-user: ${message}`)
  process.exit(1)
}

if (!existsSync(ENV_FILE)) die(`${ENV_FILE} does not exist (copy .env.example and fill DATABASE_URL first)`)
loadEnv({ path: ENV_FILE, quiet: true })

// On a first run the file only has DATABASE_URL, and it is still the owner's.
const ownerUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL
if (!ownerUrl) die(`${ENV_FILE} has neither MIGRATION_DATABASE_URL nor DATABASE_URL`)

const owner = new URL(ownerUrl)
if (owner.username === ROLE) {
  die(`${ENV_FILE}'s DATABASE_URL is already ${ROLE}; set MIGRATION_DATABASE_URL to the owner's URL and re-run`)
}

// base64url: no +, / or = to percent-encode, so the connection string cannot be
// mangled by whatever parses it next.
const password = process.env.APP_USER_PASSWORD || randomBytes(24).toString('base64url')

const pool = new Pool({ connectionString: ownerUrl })
try {
  const client = await pool.connect()
  try {
    const { rows: [role] } = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [ROLE])
    if (!role) die(`role ${ROLE} does not exist — run the migrations first (npm run db:migrate)`)

    // ALTER ROLE takes no bind parameters, so the password rides in on a GUC and
    // format(%L) quotes it. Never string-concatenated into SQL.
    await client.query('SELECT set_config($1, $2, false)', ['serveside.new_password', password])
    await client.query(`DO $$ BEGIN
      EXECUTE format('ALTER ROLE ${ROLE} WITH LOGIN PASSWORD %L', current_setting('serveside.new_password'));
    END $$;`)
    await client.query('SELECT set_config($1, $2, false)', ['serveside.new_password', ''])
  } finally {
    client.release()
  }
} finally {
  await pool.end()
}

const appUrl = new URL(ownerUrl)
appUrl.username = ROLE
appUrl.password = password

// Verify before writing: a role that can bypass RLS, or that owns a table, would
// make the whole tenancy story a no-op and the leak test vacuous.
const check = new Pool({ connectionString: appUrl.toString() })
try {
  const { rows: [row] } = await check.query(`
    SELECT current_user AS who,
           (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_super,
           (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypasses_rls,
           (SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user) AS owns`)
  if (row.who !== ROLE) die(`connected as ${row.who}, expected ${ROLE}`)
  if (row.is_super || row.bypasses_rls) die(`${ROLE} can bypass RLS — it must not`)
  if (Number(row.owns) > 0) die(`${ROLE} owns ${row.owns} tables — RLS does not bind a table owner`)
} catch (err) {
  die(`could not connect as ${ROLE}: ${err.message}`)
} finally {
  await check.end()
}

const lines = readFileSync(ENV_FILE, 'utf8').split('\n')
const upsert = (key, value) => {
  const i = lines.findIndex((l) => l.startsWith(`${key}=`))
  if (i >= 0) lines[i] = `${key}=${value}`
  else lines.push(`${key}=${value}`)
}
upsert('MIGRATION_DATABASE_URL', ownerUrl)
upsert('DATABASE_URL', appUrl.toString())
writeFileSync(ENV_FILE, lines.join('\n'), { mode: 0o600 })

console.log(`create-app-user: ${ROLE} password set; ${ENV_FILE} now points DATABASE_URL at ${ROLE}`)
console.log('create-app-user: MIGRATION_DATABASE_URL keeps the owner for drizzle-kit')
