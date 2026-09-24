/**
 * `npm run spine:proof` — the whole ordering spine, end to end, in one command.
 *
 *   npm run seed:kashi                # once, to have a restaurant
 *   npm run spine:proof               # .env.local; ENV_FILE=… for another branch
 *
 * It places a **pay-on-pickup** order through the real `createOrder` — the real
 * hours check, the real menu, the real money arithmetic, the real snapshot pin —
 * then drives the real order fan-out, waits for the ticket to appear in the queue a
 * printer polls, prints that ticket to stdout and says `SPINE OK`.
 *
 * **Why it calls `fanOut` directly.** In production nothing announces an order from
 * inside `createOrder`: the route does it (`POST /api/orders` → `sendOrderCreated`),
 * or the Stripe webhook does it once the money lands, and Inngest then runs
 * `order-created-fan-out`. This script is deliberately not an HTTP client — it proves
 * the domain, the fan-out and the ticket without booting Next or the orchestrator —
 * so it drives `fanOut(data, step)`, which is the exact function the Inngest trigger
 * wraps, with a one-line inline `step`. The production announce path is a route's
 * job, and it is what the card walkthrough at the end of this run exercises.
 *
 * **Pay-on-pickup, so there is no Stripe dependency.** That path reaches `NEW`
 * inside `createOrder` itself, which is the whole point: a restaurant with no
 * connected account can still take orders all day. The card path — PENDING_PAYMENT
 * until a signed webhook flips it — is printed as instructions at the end.
 *
 * **The SMS leg is never run**, and that is an interlock rather than a shortcut: the
 * number the fan-out texts is the restaurant's real one, so a proof that ran it would
 * text an actual kitchen about a fake order every time anybody ran this. `proofStep`
 * runs the print leg and skips everything else; the skip is printed. The owner's text
 * is covered by `src/inngest/order-created.test.ts` and by the card walkthrough at the
 * end of a run, which goes through the route and the orchestrator for real.
 *
 * **It must connect as `app_user`.** Everything it touches goes through
 * `withLocation`, which refuses a connection that can bypass RLS. If the env file
 * still points `DATABASE_URL` at the Neon owner, the run stops and says how to fix
 * it. The seeder next door is the one script that legitimately connects as the
 * owner; this one is the proof that the application's own path works without it.
 */
import { config as loadEnv } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { and, desc, eq } from 'drizzle-orm'
import type { GetStepTools } from 'inngest'
import { db } from '@/db/client'
import { locations, organizations, menuSnapshots, printJobs } from '@/db/schema'
import type { MenuSnapshotPayload, SnapshotItem } from '@/db/schema'
import { withLocation, closeScopedPool } from '@/repo/scoped'
import { createOrder, OrderRejectedError, type CreateOrderInput, type CreateOrderResult } from '@/domain/create-order'
import { fanOut } from '@/inngest/order-created'
import { inngest } from '@/inngest/client'
import { formatCents } from '@/lib/money'
import { KASHI, REAL_HOURS } from './seed-kashi'

/** The restaurant the proof orders from, unless `--location=<uuid>` names another. */
const DEFAULT_ORG_SLUG = KASHI.org.slug

/** How long a queued ticket may take to appear before the run is called failed. */
const TICKET_TIMEOUT_MS = 20_000
const TICKET_POLL_MS = 250

// ---------------------------------------------------------------------------
// Choosing what to order
// ---------------------------------------------------------------------------

export type ProofLine = { menuItemId: string; qty: number; modifierOptionIds: string[]; notes?: string }
export type ProofOrder = { items: ProofLine[]; description: string[] }

/**
 * Two lines off the pinned snapshot: one dish carrying its mandatory modifier
 * choices, and one plain one.
 *
 * Chosen from the payload rather than hardcoded, so the proof follows the menu
 * instead of going stale the day a seeded dish is renamed — and so it exercises the
 * snapshot, which is the artefact an order is actually quoted from. A dish with a
 * mandatory group is preferred for the first line because `createOrder` enforces
 * min/max, and a proof that never picks a modifier never proves that it does.
 */
export function chooseProofLines(payload: MenuSnapshotPayload): ProofOrder {
  const orderable = payload.categories
    .flatMap((category) => category.items)
    .map((item) => ({ item, selection: selectionFor(item) }))
    .filter((candidate): candidate is { item: SnapshotItem; selection: string[] } => candidate.selection !== null)

  if (orderable.length === 0) {
    throw new Error('No orderable item in the current menu snapshot — everything is 86\'d or unsatisfiable.')
  }

  // A dish with a mandatory group first; failing that, whatever is at the top.
  const first = orderable.find(({ item }) => item.modifierGroups.some((g) => g.minSelect > 0)) ?? orderable[0]
  const second = orderable.find(({ item }) => item.id !== first.item.id)

  const lines: ProofLine[] = [{
    menuItemId: first.item.id,
    qty: 2,
    modifierOptionIds: first.selection,
    // A line note and (below) an order note, because both print and both are places a
    // renderer can silently drop a customer's words.
    notes: 'extra crispy',
  }]
  const description = [describe(first.item, first.selection, 2)]

  if (second) {
    lines.push({ menuItemId: second.item.id, qty: 1, modifierOptionIds: second.selection })
    description.push(describe(second.item, second.selection, 1))
  }
  return { items: lines, description }
}

/**
 * The cheapest selection that satisfies every group on a dish, or `null` if the dish
 * cannot currently be ordered at all.
 *
 * Exactly `minSelect` options per group: an optional group contributes nothing, and a
 * mandatory one contributes the first options that are not 86'd. A group whose
 * mandatory choices are all sold out makes the whole dish unorderable, which is a
 * real state and the reason this returns `null` rather than throwing.
 */
function selectionFor(item: SnapshotItem): string[] | null {
  if (item.is86d) return null
  const chosen: string[] = []
  for (const group of item.modifierGroups) {
    if (group.minSelect <= 0) continue
    const available = group.options.filter((option) => !option.is86d).slice(0, group.minSelect)
    if (available.length < group.minSelect) return null
    chosen.push(...available.map((option) => option.id))
  }
  return chosen
}

function describe(item: SnapshotItem, selection: string[], qty: number): string {
  const names = item.modifierGroups
    .flatMap((group) => group.options.filter((option) => selection.includes(option.id)).map((o) => o.name))
  return `${qty}× ${item.name}${names.length ? ` (${names.join(', ')})` : ''}`
}

// ---------------------------------------------------------------------------
// Driving the spine
// ---------------------------------------------------------------------------

/**
 * The only leg of the fan-out this script runs. Everything else the fan-out asks for
 * is skipped — see `proofStep`.
 */
const PROOF_STEP = 'queue-print-job'

/** Printed whenever a leg is skipped, so no run of this can be mistaken for a full one. */
export const SKIPPED_NOTE = 'a proof run never texts a real restaurant; the print leg is the proof'

/**
 * The `step` the fan-out is given here: run the print leg, now, in this process, and
 * **refuse to run anything else** — which today means the SMS leg, and tomorrow means
 * whatever leg is added next.
 *
 * This is a safety interlock, not a convenience. `locations.phone_e164` is the
 * restaurant's *real* number — Kashi's is +1 917 909 0243 — and the fan-out's job is
 * to text it. The moment working `TWILIO_*` credentials land in `.env.local`, a script
 * that ran the SMS leg would text an actual restaurant about an actual-looking order
 * every time anybody ran the proof, including from a loop, including at 3am. Nothing
 * about that failure is loud: the text sends, the run goes green, and the first person
 * to hear about it is the owner.
 *
 * **Allow-list, not a block-list**, and the direction is the whole point. Naming the
 * one leg to run means a renamed or newly added leg is skipped by default: the worst
 * case is a proof that proves less. A block-list on `'sms-owner'` would fail the other
 * way — rename the step in `order-created.ts` and the guard silently stops guarding.
 * If `queue-print-job` is ever renamed, nothing is queued and this script fails
 * loudly on its own timeout, which is the failure you want.
 *
 * The cast is the same one `src/inngest/order-created.test.ts` uses: `fanOut` only ever
 * calls `step.run`, and pinning that is the point of it taking a `step` at all.
 * Skipping a step by resolving without running its callback is also exactly what the
 * real orchestrator does with a memoized step — the shape is not a lie, only the
 * reason.
 */
export function proofStep(skipped: string[] = []): GetStepTools<typeof inngest> {
  return {
    run: (id: string, fn: () => Promise<unknown>) => {
      if (id === PROOF_STEP) return fn()
      skipped.push(id)
      return Promise.resolve(undefined)
    },
  } as unknown as GetStepTools<typeof inngest>
}

/** The newest pinned menu for a location — what an order is quoted from. */
export async function currentSnapshot(
  locationId: string,
): Promise<{ id: string; version: number; payload: MenuSnapshotPayload }> {
  const [snapshot] = await withLocation(locationId, (tx) => tx
    .select({ id: menuSnapshots.id, version: menuSnapshots.version, payload: menuSnapshots.payload })
    .from(menuSnapshots)
    .where(eq(menuSnapshots.locationId, locationId))
    .orderBy(desc(menuSnapshots.version))
    .limit(1))
  if (!snapshot) {
    throw new Error(`Location ${locationId} has no menu snapshot. Run: npm run seed:kashi`)
  }
  return snapshot
}

/**
 * Waits for the ticket the fan-out queued.
 *
 * Polls the same way a Star printer does — `status = 'queued'`, this location, this
 * order — because that is the query whose answer decides whether a kitchen ever sees
 * the order. Bounded: a proof that hangs is a proof nobody runs.
 */
export async function awaitQueuedTicket(
  locationId: string,
  orderId: string,
  timeoutMs = TICKET_TIMEOUT_MS,
): Promise<{ id: string; payload: string }> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const [job] = await withLocation(locationId, (tx) => tx
      .select({ id: printJobs.id, payload: printJobs.payload })
      .from(printJobs)
      .where(and(eq(printJobs.orderId, orderId), eq(printJobs.status, 'queued')))
      .limit(1))
    if (job) return job
    if (Date.now() >= deadline) {
      throw new Error(`No queued print job for order ${orderId} after ${timeoutMs}ms — the ticket never reached the queue.`)
    }
    await new Promise((resolve) => setTimeout(resolve, TICKET_POLL_MS))
  }
}

export type ProofResult = {
  locationId: string
  order: CreateOrderResult
  ticket: string
  printJobId: string
  /** The fan-out legs `proofStep` refused to run — `['sms-owner']` today. */
  skippedSteps: string[]
  description: string[]
}

/**
 * **A different fake customer every run**, in the 555 area code, which the NANP never
 * assigns — so it is E.164-shaped (`assertInputShape` insists) and cannot ring anyone.
 *
 * It used to be one fixed number, and the unpaid-order cap is what makes that wrong:
 * a proof leaves its order **open** at NEW forever, and nothing tears the test branch
 * or a dev database down, so the eleventh run of the day against one location was
 * refused `unpaid_order_cap` — the proof failing for the one reason that is not a bug.
 * Ten proofs on one number genuinely *is* ten unpaid dinners on one phone; they are
 * separate fake customers, so they get separate fake numbers.
 */
export function proofPhone(): string {
  return `+1555${String(Date.now()).slice(-7)}`
}

/**
 * Place, fan out, wait for the ticket. The whole spine, minus HTTP.
 *
 * Exported so the suite can drive exactly what the CLI drives, against a location
 * seeded on the test branch — the alternative being a script nothing but a human
 * ever runs.
 */
export async function runProof(locationId: string): Promise<ProofResult> {
  const snapshot = await currentSnapshot(locationId)
  const { items, description } = chooseProofLines(snapshot.payload)

  const input: CreateOrderInput = {
    locationId,
    channel: 'web',
    fulfillment: 'pickup',
    contact: { name: 'Spine Proof', phone: proofPhone(), email: 'proof@serveside.test' },
    items,
    tipCents: 500,
    payment: 'pay_on_pickup',
  }
  const order = await createOrder(input)

  // Not wrapped in a try: with only the print leg running, every way `fanOut` can
  // throw is a print leg that failed, and that is the thing this script exists to
  // catch. The ticket is still waited for below, so a leg that "succeeded" and wrote
  // nothing fails the run a moment later anyway.
  const skippedSteps: string[] = []
  await fanOut({ orderId: order.orderId, locationId }, proofStep(skippedSteps))

  const job = await awaitQueuedTicket(locationId, order.orderId)
  return { locationId, order, ticket: job.payload, printJobId: job.id, skippedSteps, description }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

type Target = { id: string; name: string; timezone: string }

/**
 * The location to order from: `--location=<uuid>`, else the single location of the
 * org named by `--org=<slug>` (default `kashi`).
 *
 * `organizations` and `locations` carry no RLS — they are the tenancy root — so this
 * is the one read here that goes through the stateless driver.
 */
async function resolveTarget(argv: string[]): Promise<Target> {
  const explicit = flag(argv, '--location')
  const orgSlug = flag(argv, '--org') ?? DEFAULT_ORG_SLUG

  const rows = await db()
    .select({ id: locations.id, name: locations.name, timezone: locations.timezone })
    .from(locations)
    .innerJoin(organizations, eq(locations.orgId, organizations.id))
    .where(explicit ? eq(locations.id, explicit) : eq(organizations.slug, orgSlug))

  if (rows.length === 0) {
    throw new Error(explicit
      ? `No location ${explicit} on this database.`
      : `No location for org "${orgSlug}" on this database. Run: npm run seed:kashi`)
  }
  if (rows.length > 1) {
    const slugs = rows.map((row) => row.id).join(', ')
    throw new Error(`Org "${orgSlug}" has ${rows.length} locations; name one with --location=<uuid>: ${slugs}`)
  }
  return rows[0]
}

function flag(argv: string[], name: string): string | undefined {
  return argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1)
}

async function main(): Promise<void> {
  const envFile = process.env.ENV_FILE ?? '.env.local'
  loadEnv({ path: envFile, quiet: true })

  const target = await resolveTarget(process.argv.slice(2))
  // The zone is on the header line because the ticket's promised time is printed in
  // it — a "Ready 8:35 AM" with no zone attached is the one number on a ticket that
  // can be wrong without looking wrong.
  console.log(`spine:proof: ${envFile} — ${target.name} · ${target.timezone} (${target.id})`)

  const result = await runProof(target.id)
  const { order } = result

  console.log('')
  console.log(`  ordered    ${result.description.join(', ')}`)
  console.log(`  order      ${order.shortCode} · ${order.status} · $${formatCents(order.totalCents)} (${order.orderId})`)
  console.log(`  print job  ${result.printJobId} · queued`)
  if (result.skippedSteps.length > 0) {
    console.log(`  skipped    ${result.skippedSteps.join(', ')} — ${SKIPPED_NOTE}`)
  }

  // The stored payload, byte for byte, at the width it will print at — 32 columns of
  // Star mC-Print3 roll. No fence around it: the ticket draws its own rules, and a
  // wider one here would make a 33-column line look like it fitted.
  console.log('')
  console.log('  ticket (print_jobs.payload, verbatim, 32 columns):')
  console.log('')
  process.stdout.write(result.ticket)
  console.log('')
  printCardPath(target, result)
  console.log('SPINE OK')
}

/**
 * The half this script deliberately does not automate.
 *
 * A card order is only proved by a **signed** Stripe event, so the walkthrough is the
 * honest form: run the listener, place the order, pay it, watch the flip. It also
 * exercises the announce path this script bypasses — `POST /api/orders` sends the
 * Inngest event itself, so the ticket comes out of the orchestrator rather than out
 * of the inline step above.
 */
function printCardPath(target: Target, result: ProofResult): void {
  const items = result.description.join(', ')
  console.log('The card path, which needs Stripe and is therefore a walkthrough, not a script:')
  console.log('')
  console.log('  1. npx inngest-cli dev                 # the orchestrator; discovers /api/inngest')
  console.log('  2. npm run dev                         # localhost:3000')
  console.log('  3. stripe listen --forward-to localhost:3000/api/stripe/webhook')
  console.log('     Put the whsec_… it prints in STRIPE_WEBHOOK_SECRET — a dashboard')
  console.log('     endpoint\'s secret will fail every signature with no other symptom.')
  console.log(`  4. The location needs a connected account first: locations.stripe_account_id`)
  console.log(`     is null for ${target.name}, so a card order answers 503 stripe_account_missing.`)
  console.log('  5. POST /api/orders with the same body this run used and payment: "card"')
  console.log(`     (${items}) → { orderId, shortCode, clientSecret }, order at PENDING_PAYMENT.`)
  console.log('  6. Confirm the PaymentIntent with test card 4242 4242 4242 4242, any future')
  console.log('     expiry, any CVC. The webhook flips PENDING_PAYMENT → NEW, sets the ready')
  console.log('     time, and fans out — watch the run in the Inngest dev UI and the ticket')
  console.log('     appear on /feed/<location>.')
  console.log('')
}

/**
 * Failures with a next step attached. Every one of these is something a person hits
 * the first time they run this on a fresh branch.
 */
function explain(err: unknown): string[] {
  const message = err instanceof Error ? err.message : String(err)

  if (message.includes('Missing required env var: DATABASE_URL')) {
    return [
      message,
      '',
      `Nothing in ${process.env.ENV_FILE ?? '.env.local'} sets it. Copy .env.example, paste the Neon`,
      'connection string in, then: ENV_FILE=<that file> npm run db:migrate && npm run db:app-user',
    ]
  }
  if (message.includes('bypasses row-level security')) {
    return [
      'DATABASE_URL connects as the database owner, which row-level security does not bind.',
      'The proof goes through the application\'s own path, so it needs app_user:',
      '',
      '  ENV_FILE=.env.local npm run db:app-user',
      '',
      'That sets app_user\'s password, moves the owner to MIGRATION_DATABASE_URL (where only',
      'drizzle-kit and the seeder read it) and points DATABASE_URL at app_user.',
    ]
  }
  if (err instanceof OrderRejectedError && err.code === 'location_closed') {
    const hours = REAL_HOURS.map((row) => `${'SunMonTueWedThuFriSat'.slice(row.dow * 3, row.dow * 3 + 3)} `
      + `${row.openTime.slice(0, 5)}–${row.closeTime.slice(0, 5)}`).join(', ')
    return [
      message,
      '',
      `createOrder asks the real hours at the real clock, and Kashi's seeded grid is their real one: ${hours} (${KASHI.location.timezone}).`,
      'Run the proof during service, or seed the dev database with the around-the-clock demo grid:',
      '',
      '  npm run seed:kashi -- --hours=always-open',
      '',
      'That grid is a development convenience and never a restaurant\'s. `npm run seed:kashi` puts the real hours back.',
    ]
  }
  if (err instanceof OrderRejectedError && err.code === 'menu_unavailable') {
    return [message, '', 'A location needs exactly one active menu. Re-seed it: npm run seed:kashi']
  }
  if (message.includes('No orderable item')) {
    return [
      message,
      '',
      'Every dish on the pinned menu is either 86\'d or has a mandatory modifier group whose',
      'options are all 86\'d. **A re-seed will not fix this**: 86 is the kitchen\'s switch and',
      '`seed-kashi` deliberately never clears it, because putting a sold-out dish back on sale',
      'silently is how you sell food that does not exist. Put one back on the menu instead:',
      '',
      '  DELETE /api/menu/86?location=<slug>   { "itemId": "<uuid>" }',
      '',
      'or tap it back on from the kitchen feed. The hourly unsnooze job clears anything that',
      'was 86\'d "until tomorrow" on its own.',
    ]
  }
  return [message]
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
    .then(() => closeScopedPool())
    .catch(async (err: unknown) => {
      console.error('')
      console.error('spine:proof failed.')
      for (const line of explain(err)) console.error(line === '' ? '' : `  ${line}`)
      await closeScopedPool().catch(() => {})
      process.exit(1)
    })
}
