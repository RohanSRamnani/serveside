# Ordering Spine Implementation Plan (Plan 1 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A hand-crafted order can be paid for through Stripe and prints on a kitchen printer — the spine of the Serveside ordering platform (spec stages 1–3).

**Architecture:** One Next.js 16 app (`serveside` repo) with a Neon Postgres database accessed through Drizzle and a location-scoped repository layer backed by Postgres RLS. Order submission is an isolated write path that fans out three ways (DB row, CloudPRNT print job, owner SMS) via Inngest durable steps. The order feed polls every 5 seconds — no websockets. Stripe Connect Standard with direct charges: the restaurant is merchant of record; we never hold funds.

**Tech Stack:** Next.js 16 (App Router, `proxy.ts` not `middleware.ts`), TypeScript strict, Neon Postgres + Drizzle ORM, Inngest, Stripe (Connect Standard, direct charges, Payment Element), Twilio SMS, Star CloudPRNT, Clerk Organizations, Vitest.

## Global Constraints

Copied from the spec — every task implicitly includes these:

- **All money is `bigint` cents. Never floats.** (Drizzle `bigint({ mode: 'number' })`.)
- **Every domain table carries `org_id` or `location_id`.** Menus, hours, orders scope to **location**, not org.
- **Tenancy is belt-and-braces:** scoped repository layer AND Postgres RLS. One missing WHERE clause must not leak another restaurant's orders.
- **Names and prices are snapshotted onto order rows.** Never join a historical order to a live menu item.
- **`order_events` is append-only.** Every state change writes an event.
- **Every order references a `menu_snapshot_id`.**
- **Webhook idempotency:** `webhook_events.external_id UNIQUE` guards Stripe/Twilio double delivery.
- **Stripe: Connect Standard + direct charges only.** Charge created on the connected account via `stripeAccount` header. Never separate charges + transfers, never destination charges. Payment Element only (SAQ A) — card data never touches our servers.
- **Order feed realtime is 5-second polling.** No websockets.
- **No POS integration.** A `PosAdapter` interface with a null implementation ships; nothing may depend on a POS.
- **Order fan-out:** DB row, printer job, owner SMS — two of three can fail and a human still gets the order.
- **86 works on modifier options too**, and `unsnooze_at` gives "86 until tomorrow."
- **`business_hours` supports multiple ranges per day** (split lunch/dinner service).
- **Status machine:** `PENDING_PAYMENT → NEW → ACCEPTED → IN_KITCHEN → READY → COMPLETED`, with `NEW → REJECTED` and `→ CANCELED` from any non-terminal state. Voice/pay-at-pickup orders enter at `NEW` with `payment_status = PAY_ON_PICKUP`.
- TDD throughout; Vitest; frequent commits. Node 22. Repo: `/Users/rohan/Projects/AgenticAgency/serveside`.

## External accounts (Rohan's side — tasks note which ones they need)

| Service | Needed by task | Notes |
|---|---|---|
| Neon | Task 1 | Can be provisioned via the Neon MCP from the session. One project, `main` + `test` branches. |
| Stripe (platform account, test mode) | Task 9 | Connect Standard enabled; test keys in `.env.local`. Kashi's real connected account is a Stage-0 external — tests use test-mode + mocks. |
| Twilio | Task 10 | Trial account + one number works for dev (SMS to verified numbers only). A2P 10DLC registration is a Stage-0 external — file it now; production SMS is gated on it. |
| Inngest | Task 10 | `npx inngest-cli dev` needs no account locally. Cloud account needed at deploy time only. |
| Clerk | Task 12 | Free tier; one application; enable Organizations. |

## File Structure

```
serveside/
  src/
    db/
      schema/
        tenancy.ts        # organizations, locations, memberships
        menu.ts           # menus, categories, items, modifiers, availability
        snapshots.ts      # menu_snapshots
        hours.ts          # business_hours, holiday_closures, order_pauses
        orders.ts         # orders, order_items, order_item_modifiers, order_events
        platform.ts       # printers, print_jobs, webhook_events
        index.ts          # re-exports all tables
      client.ts           # Neon + Drizzle client factory
      migrate.ts          # migration runner
    lib/
      env.ts              # typed env access, fails fast on missing vars
      money.ts            # cents helpers, tax math (bankers' no — half-up)
      short-code.ts       # order short codes
    domain/
      order-status.ts     # the state machine (pure)
      snapshot.ts         # buildMenuSnapshot(locationId)
      hours.ts            # isOpenAt(location, date)
      create-order.ts     # createOrder(input) — the isolated write path
      ticket.ts           # renderTicket(order) -> Star markup text
      pos-adapter.ts      # PosAdapter interface + NullPosAdapter
    repo/
      scoped.ts           # withLocation(locationId, fn) — sets RLS context
      orders-repo.ts
      menu-repo.ts
    inngest/
      client.ts
      order-created.ts    # fan-out function (print job, SMS)
      unsnooze.ts         # nightly 86 auto-clear
      stale-order-alert.ts# NEW > 6 min during open hours
    app/
      api/
        orders/route.ts               # POST create order
        orders/[id]/transition/route.ts
        feed/route.ts                 # GET polling feed
        stripe/webhook/route.ts
        printers/cloudprnt/route.ts   # POST poll / GET job / DELETE confirm
        inngest/route.ts
      feed/[location]/page.tsx        # tablet feed (minimal)
    proxy.ts              # Clerk auth wiring (Next 16 name)
  scripts/
    seed-kashi.ts
    place-test-order.ts   # the spine's definition-of-done script
  drizzle/                # generated migrations
  docs/superpowers/{specs,plans}/
  CLAUDE.md
```

---

### Task 1: Repo scaffold, database client, env plumbing

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `vitest.config.ts`, `.env.example`, `.gitignore`, `CLAUDE.md`
- Create: `src/lib/env.ts`, `src/db/client.ts`, `drizzle.config.ts`
- Test: `src/lib/env.test.ts`

**Interfaces:**
- Produces: `env(name: string): string` (throws on missing), `db()` → Drizzle instance bound to `DATABASE_URL`.

- [ ] **Step 1: Scaffold the app**

```bash
cd /Users/rohan/Projects/AgenticAgency/serveside
npx create-next-app@latest . --ts --app --no-tailwind --no-eslint --src-dir --import-alias "@/*" --skip-install
npm install drizzle-orm @neondatabase/serverless
npm install -D drizzle-kit vitest @types/node dotenv
```

(If `create-next-app` balks at the non-empty dir because of `docs/` and `.git`, scaffold into `/tmp/ss-scaffold` and move everything except `docs` in.)

- [ ] **Step 2: Provision Neon**

Create a Neon project `serveside` (region iad) with branches `main` and `test` (Neon MCP: `create_project`, then `create_branch { name: "test" }`). Put the `main` connection string in `.env.local` as `DATABASE_URL` and the `test` branch string in `.env.test` as `DATABASE_URL`. Copy both keys (values blank) into `.env.example`.

- [ ] **Step 3: Write the failing env test**

```ts
// src/lib/env.test.ts
import { describe, it, expect } from 'vitest'
import { env } from './env'

describe('env', () => {
  it('returns a set variable', () => {
    process.env.SPINE_TEST_VAR = 'x'
    expect(env('SPINE_TEST_VAR')).toBe('x')
  })
  it('throws with the variable name on missing', () => {
    delete process.env.SPINE_MISSING
    expect(() => env('SPINE_MISSING')).toThrow(/SPINE_MISSING/)
  })
})
```

Run: `npx vitest run src/lib/env.test.ts` → FAIL (module not found).

- [ ] **Step 4: Implement env + db client**

```ts
// src/lib/env.ts
export function env(name: string): string {
  const v = process.env[name]
  if (v === undefined || v === '') throw new Error(`Missing required env var: ${name}`)
  return v
}
```

```ts
// src/db/client.ts
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
```

```ts
// drizzle.config.ts
import { defineConfig } from 'drizzle-kit'
export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL! },
})
```

`vitest.config.ts` loads `.env.test` via `dotenv/config` with `envFile` setup:

```ts
import { defineConfig } from 'vitest/config'
import path from 'node:path'
export default defineConfig({
  test: { setupFiles: ['./vitest.setup.ts'], pool: 'forks', fileParallelism: false },
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
})
```

```ts
// vitest.setup.ts
import { config } from 'dotenv'
config({ path: '.env.test' })
```

(`fileParallelism: false`: DB tests share one test branch; keep them serial and deterministic.)

- [ ] **Step 5: Verify green, write CLAUDE.md, commit**

Run: `npx vitest run` → PASS.

`CLAUDE.md` (initial, ~15 lines): what the repo is (Serveside ordering backend — spec in docs/superpowers/specs/), money-in-cents rule, location-scoping rule, `npx vitest run` (serial, hits the Neon `test` branch), `npx drizzle-kit generate` + `npm run db:migrate`, and the spine plan pointer.

```bash
git add -A && git commit -m "chore: scaffold Next 16 app, Neon + Drizzle client, typed env"
```

---

### Task 2: Tenancy schema (organizations, locations, memberships)

**Files:**
- Create: `src/db/schema/tenancy.ts`, `src/db/schema/index.ts` (migrations run via the `db:migrate` npm script — no `migrate.ts` module)
- Test: `src/db/schema/tenancy.test.ts`

**Interfaces:**
- Produces: tables `organizations { id uuid pk, name, slug unique, clerkOrgId unique nullable, createdAt }`, `locations { id uuid pk, orgId fk, name, slug, address, timezone, phoneE164, prepTimeMinutes int default 20, taxRatePer100k int, pickupEnabled bool default true, deliveryEnabled bool default false, stripeAccountId text nullable, status text default 'active', createdAt }`, `memberships { userId text, orgId fk, locationId fk nullable, role enum('owner','manager','staff') }`. Types exported as `Organization`, `Location`.

- [ ] **Step 1: Failing round-trip test**

```ts
// src/db/schema/tenancy.test.ts
import { describe, it, expect } from 'vitest'
import { db } from '@/db/client'
import { organizations, locations } from '@/db/schema'
import { eq } from 'drizzle-orm'

describe('tenancy schema', () => {
  it('inserts an org with a location and reads it back', async () => {
    const [org] = await db().insert(organizations).values({ name: 'Test Org', slug: `t-${Date.now()}` }).returning()
    const [loc] = await db().insert(locations).values({
      orgId: org.id, name: 'Main', slug: 'main', address: '1 Test St, Brooklyn, NY',
      timezone: 'America/New_York', phoneE164: '+15550000001', taxRatePer100k: 8750,
    }).returning()
    const found = await db().query.locations.findFirst({ where: eq(locations.id, loc.id), with: { org: true } })
    expect(found?.org.name).toBe('Test Org')
    expect(found?.taxRatePer100k).toBe(8750)
  })
})
```

Run → FAIL (tables missing).

- [ ] **Step 2: Write the schema**

```ts
// src/db/schema/tenancy.ts
import { pgTable, uuid, text, integer, boolean, timestamp, pgEnum, primaryKey } from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'

export const membershipRole = pgEnum('membership_role', ['owner', 'manager', 'staff'])

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  clerkOrgId: text('clerk_org_id').unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const locations = pgTable('locations', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  address: text('address').notNull(),
  timezone: text('timezone').notNull(),
  phoneE164: text('phone_e164').notNull(),
  prepTimeMinutes: integer('prep_time_minutes').notNull().default(20),
  taxRatePer100k: integer('tax_rate_per_100k').notNull(),
  pickupEnabled: boolean('pickup_enabled').notNull().default(true),
  deliveryEnabled: boolean('delivery_enabled').notNull().default(false),
  stripeAccountId: text('stripe_account_id'),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const memberships = pgTable('memberships', {
  userId: text('user_id').notNull(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  locationId: uuid('location_id').references(() => locations.id),
  role: membershipRole('role').notNull(),
}, (t) => [primaryKey({ columns: [t.userId, t.orgId] })])

export const organizationsRelations = relations(organizations, ({ many }) => ({ locations: many(locations) }))
export const locationsRelations = relations(locations, ({ one }) => ({
  org: one(organizations, { fields: [locations.orgId], references: [organizations.id] }),
}))

export type Organization = typeof organizations.$inferSelect
export type Location = typeof locations.$inferSelect
```

`src/db/schema/index.ts` re-exports everything; add each new schema file here as later tasks create them.

- [ ] **Step 3: Generate + run migration against the test branch, verify green**

```bash
npx drizzle-kit generate
DATABASE_URL=$(grep DATABASE_URL .env.test | cut -d= -f2-) npx drizzle-kit migrate
npx vitest run src/db/schema/tenancy.test.ts
```

Expected: PASS. Add `"db:migrate": "drizzle-kit migrate"` to package.json scripts.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: tenancy schema — organizations, locations, memberships"
```

---

### Task 3: Menu schema (categories, items, modifiers, availability, 86)

**Files:**
- Create: `src/db/schema/menu.ts` (register in `index.ts`)
- Test: `src/db/schema/menu.test.ts`

**Interfaces:**
- Produces: `menus { id, locationId, name, isActive }`, `menuCategories { id, menuId, name, sort, availabilityWindowId nullable }`, `menuItems { id, categoryId, name, description, basePriceCents bigint, photoUrl, sort, isActive, taxCategory, tags text[], is86d bool default false, unsnoozeAt timestamptz nullable }`, `modifierGroups { id, locationId, name, minSelect int, maxSelect int, required bool }`, `modifierOptions { id, groupId, name, priceDeltaCents bigint, isActive, is86d, unsnoozeAt }`, `itemModifierGroups { itemId, groupId, sort, minOverride nullable, maxOverride nullable }`, `availabilityWindows { id, locationId, dow int, startTime, endTime }`.
- Consumes: `locations` from Task 2.

- [ ] **Step 1: Failing test — a seeded three-item menu with a shared modifier group**

```ts
// src/db/schema/menu.test.ts
import { describe, it, expect } from 'vitest'
import { db } from '@/db/client'
import { organizations, locations, menus, menuCategories, menuItems, modifierGroups, modifierOptions, itemModifierGroups } from '@/db/schema'

async function seedLocation() {
  const [org] = await db().insert(organizations).values({ name: 'M', slug: `m-${Date.now()}` }).returning()
  const [loc] = await db().insert(locations).values({
    orgId: org.id, name: 'Main', slug: 'main', address: 'x', timezone: 'America/New_York',
    phoneE164: '+15550000002', taxRatePer100k: 8750,
  }).returning()
  return loc
}

describe('menu schema', () => {
  it('models items with a reusable location-scoped modifier group', async () => {
    const loc = await seedLocation()
    const [menu] = await db().insert(menus).values({ locationId: loc.id, name: 'Dinner', isActive: true }).returning()
    const [cat] = await db().insert(menuCategories).values({ menuId: menu.id, name: 'Mains', sort: 1 }).returning()
    const [spice] = await db().insert(modifierGroups).values({ locationId: loc.id, name: 'Spice Level', minSelect: 1, maxSelect: 1, required: true }).returning()
    await db().insert(modifierOptions).values([
      { groupId: spice.id, name: 'Mild', priceDeltaCents: 0 },
      { groupId: spice.id, name: 'Hot', priceDeltaCents: 0 },
    ])
    const [item] = await db().insert(menuItems).values({
      categoryId: cat.id, name: 'Butter Chicken', description: 'Tomato, cream, fenugreek.',
      basePriceCents: 1800, sort: 1, tags: ['gluten-free'],
    }).returning()
    await db().insert(itemModifierGroups).values({ itemId: item.id, groupId: spice.id, sort: 1 })
    expect(item.basePriceCents).toBe(1800)
    expect(item.is86d).toBe(false)
  })
})
```

Run → FAIL.

- [ ] **Step 2: Write the schema** — mirror the Interfaces block exactly; money columns `bigint('base_price_cents', { mode: 'number' })`; `tags: text('tags').array()`; every table's FK chain reaches a location. Register exports in `index.ts`.

- [ ] **Step 3: Generate migration, migrate test branch, verify green** (same commands as Task 2 Step 3).

- [ ] **Step 4: Commit** — `feat: menu schema with reusable modifier groups and 86 fields`

---

### Task 4: Menu snapshots

**Files:**
- Create: `src/db/schema/snapshots.ts`, `src/domain/snapshot.ts`
- Test: `src/domain/snapshot.test.ts`

**Interfaces:**
- Produces: table `menuSnapshots { id uuid, locationId, version int, payload jsonb, createdAt }`; `buildMenuSnapshot(locationId: string): Promise<{ id: string; version: number }>` — serializes the location's active menu (categories → items → modifier groups/options, including `is86d` flags and prices) into `payload`, version = previous max + 1.
- Consumes: menu tables (Task 3).

- [ ] **Step 1: Failing test**

```ts
// src/domain/snapshot.test.ts
import { describe, it, expect } from 'vitest'
import { buildMenuSnapshot } from './snapshot'
import { db } from '@/db/client'
import { menuSnapshots } from '@/db/schema'
import { eq } from 'drizzle-orm'
// reuse the seeding helper pattern from menu.test.ts (extract to src/test/seed.ts in this step)

describe('buildMenuSnapshot', () => {
  it('captures items with prices and increments version', async () => {
    const loc = await seedLocationWithMenu() // from src/test/seed.ts — 1 category, 2 items, 1 modifier group
    const first = await buildMenuSnapshot(loc.id)
    const second = await buildMenuSnapshot(loc.id)
    expect(second.version).toBe(first.version + 1)
    const row = await db().query.menuSnapshots.findFirst({ where: eq(menuSnapshots.id, second.id) })
    const payload = row!.payload as any
    expect(payload.categories[0].items).toHaveLength(2)
    expect(payload.categories[0].items[0].basePriceCents).toBeTypeOf('number')
    expect(payload.categories[0].items[0].modifierGroups[0].options.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Implement** — schema table + `buildMenuSnapshot` doing one relational query for the active menu, mapping to a plain JSON shape `{ menuId, categories: [{ id, name, items: [{ id, name, basePriceCents, is86d, modifierGroups: [{ id, name, minSelect, maxSelect, required, options: [{ id, name, priceDeltaCents, is86d }] }] }] }] }`, `version: sql`coalesce(max(version),0)+1`` scoped to location within a transaction. Extract the shared test seeder to `src/test/seed.ts` (exports `seedLocation()` and `seedLocationWithMenu()`).

- [ ] **Step 3: Migrate + verify green.**
- [ ] **Step 4: Commit** — `feat: immutable menu snapshots with per-location versioning`

---

### Task 5: Hours, closures, pauses + isOpenAt

**Files:**
- Create: `src/db/schema/hours.ts`, `src/domain/hours.ts`
- Test: `src/domain/hours.test.ts`

**Interfaces:**
- Produces: tables `businessHours { id, locationId, dow int (0=Sun), openTime time, closeTime time }` (multiple rows per dow = split service), `holidayClosures { id, locationId, startsAt, endsAt, reason }`, `orderPauses { id, locationId, until timestamptz, reason, createdBy }`; function `isOpenAt(locationId: string, at: Date): Promise<{ open: boolean; reason?: 'closed_hours' | 'holiday' | 'paused' }>` evaluated in the location's timezone.
- Consumes: `locations.timezone` (Task 2).

- [ ] **Step 1: Failing tests** — three cases with a location in `America/New_York` having split hours Tue 11:30–15:00 and 17:00–22:00: (a) Tue 16:00 ET → `{ open: false, reason: 'closed_hours' }`; (b) Tue 18:00 ET → open; (c) Tue 18:00 ET with an `orderPauses` row `until` an hour later → `{ open: false, reason: 'paused' }`. Build `Date`s from UTC equivalents (e.g. 18:00 ET = 22:00 UTC in September).

- [ ] **Step 2: Implement** — schema + `isOpenAt` using `Intl.DateTimeFormat` with `timeZone` to get local dow/HH:MM, then: pause row where `until > at` → paused; closure window containing `at` → holiday; else any hours row with `openTime <= local < closeTime` → open.

- [ ] **Step 3: Migrate + green.**
- [ ] **Step 4: Commit** — `feat: business hours (split service), closures, pause switch, isOpenAt`

---

### Task 6: Order schema + status machine

**Files:**
- Create: `src/db/schema/orders.ts`, `src/domain/order-status.ts`, `src/lib/short-code.ts`
- Test: `src/domain/order-status.test.ts`

**Interfaces:**
- Produces: enums `orderStatus('PENDING_PAYMENT','NEW','ACCEPTED','IN_KITCHEN','READY','COMPLETED','REJECTED','CANCELED')`, `paymentStatus('REQUIRES_PAYMENT','PAID','PAY_ON_PICKUP','REFUNDED')`, `orderChannel('web','voice','sms')`, `fulfillment('pickup','delivery')`; tables `orders` (all spec columns: contact fields, `scheduledFor`, `quotedReadyAt`, the six money columns as bigint cents, `stripePaymentIntentId`, `menuSnapshotId` NOT NULL, notes, lifecycle timestamps), `orderItems { id, orderId, menuItemId, nameSnapshot, qty, unitPriceCents, lineTotalCents, notes }`, `orderItemModifiers { orderItemId, modifierOptionId, nameSnapshot, priceDeltaCents }`, `orderEvents { id, orderId, type, actor, payload jsonb, at }`.
- Produces: `canTransition(from: OrderStatus, to: OrderStatus): boolean` and `transition(order, to, actor): { next: OrderStatus; event: NewOrderEvent }` (throws `IllegalTransitionError`); `makeShortCode(): string` (4 chars, unambiguous alphabet `23456789ABCDEFGHJKMNPQRSTVWXYZ`).

- [ ] **Step 1: Failing state-machine tests**

```ts
// src/domain/order-status.test.ts
import { describe, it, expect } from 'vitest'
import { canTransition } from './order-status'

const legal: Array<[string, string]> = [
  ['PENDING_PAYMENT', 'NEW'], ['PENDING_PAYMENT', 'CANCELED'],
  ['NEW', 'ACCEPTED'], ['NEW', 'REJECTED'], ['NEW', 'CANCELED'],
  ['ACCEPTED', 'IN_KITCHEN'], ['ACCEPTED', 'READY'], ['ACCEPTED', 'CANCELED'],
  ['IN_KITCHEN', 'READY'], ['IN_KITCHEN', 'CANCELED'],
  ['READY', 'COMPLETED'], ['READY', 'CANCELED'],
]
const illegal: Array<[string, string]> = [
  ['COMPLETED', 'CANCELED'], ['REJECTED', 'NEW'], ['CANCELED', 'NEW'],
  ['NEW', 'READY'], ['NEW', 'COMPLETED'], ['PENDING_PAYMENT', 'ACCEPTED'],
]

describe('order status machine', () => {
  it.each(legal)('%s → %s is legal', (a, b) => expect(canTransition(a as any, b as any)).toBe(true))
  it.each(illegal)('%s → %s is illegal', (a, b) => expect(canTransition(a as any, b as any)).toBe(false))
})
```

- [ ] **Step 2: Implement** — machine as a `Record<OrderStatus, OrderStatus[]>`; `transition` returns the event row `{ type: 'status_changed', actor, payload: { from, to } }`. Schema per Interfaces; `menuSnapshotId` NOT NULL references `menu_snapshots`.

- [ ] **Step 3: Migrate + green.**
- [ ] **Step 4: Commit** — `feat: order schema, append-only events, status machine`

---

### Task 7: Scoped repository layer + Postgres RLS

**Files:**
- Create: `src/repo/scoped.ts`, `src/repo/orders-repo.ts`, `src/repo/menu-repo.ts`, `drizzle/XXXX_rls.sql` (custom migration)
- Test: `src/repo/rls.test.ts`

**Interfaces:**
- Produces: `withLocation<T>(locationId: string, fn: (tx) => Promise<T>): Promise<T>` — opens a transaction, `SET LOCAL app.location_id = $1`, runs `fn`; `ordersRepo(tx)` with `listSince(sinceIso)`, `getById(id)`, `insertOrder(...)`; `menuRepo(tx)` with `activeMenu()`, `set86(itemId, until)`.
- RLS policies on `orders`, `order_items`, `order_item_modifiers`, `order_events`, `menus` chain: `USING (location_id = current_setting('app.location_id', true)::uuid)` (tables without a direct `location_id` police via their parent FK subquery).

**Note:** the Neon HTTP driver is stateless — `SET LOCAL` requires the session/websocket driver for transactions. `withLocation` uses `drizzle-orm/neon-serverless` (Pool) rather than neon-http; keep `db()` (http) for one-shot reads that don't need RLS context, `withLocation` for everything tenant-scoped. Also create the non-superuser `app_user` role in the RLS migration and connect with it in `.env.test`'s `DATABASE_URL` — RLS does not apply to table owners.

- [ ] **Step 1: The leak test (write it first — it is the point of the task)**

```ts
// src/repo/rls.test.ts
import { describe, it, expect } from 'vitest'
import { withLocation } from './scoped'
import { seedLocationWithMenu, seedPaidOrder } from '@/test/seed'

describe('RLS tenancy', () => {
  it('a location cannot read another location\'s orders even with a raw unfiltered query', async () => {
    const locA = await seedLocationWithMenu()
    const locB = await seedLocationWithMenu()
    await seedPaidOrder(locA.id) // seeds via withLocation(locA)
    const visible = await withLocation(locB.id, async (tx) =>
      tx.execute(sql`select id from orders`) // deliberately unscoped SQL
    )
    expect(visible.rows).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Implement `withLocation` + repos + the RLS migration** (`ALTER TABLE ... ENABLE ROW LEVEL SECURITY; CREATE POLICY ...` per table; `GRANT` to `app_user`). `seedPaidOrder` goes into `src/test/seed.ts`: snapshot → order (status NEW, paymentStatus PAID) with one item.

- [ ] **Step 3: Migrate + green** (the leak test failing-then-passing is the proof; also run the whole suite to catch RLS breaking earlier tests — earlier direct `db()` seeds may need `withLocation` rewrites; do them now).

- [ ] **Step 4: Commit** — `feat: location-scoped repos with Postgres RLS belt-and-braces`

---

### Task 8: createOrder — the isolated write path

**Files:**
- Create: `src/domain/create-order.ts`, `src/lib/money.ts`
- Test: `src/domain/create-order.test.ts`, `src/lib/money.test.ts`

**Interfaces:**
- Consumes: `buildMenuSnapshot` (T4), `isOpenAt` (T5), order tables (T6), `withLocation` (T7).
- Produces:

```ts
type CreateOrderInput = {
  locationId: string
  channel: 'web' | 'voice' | 'sms'
  fulfillment: 'pickup'
  contact: { name: string; phone: string; email?: string }
  items: Array<{ menuItemId: string; qty: number; modifierOptionIds: string[]; notes?: string }>
  tipCents: number
  payment: 'card' | 'pay_on_pickup'
}
type CreateOrderResult = { orderId: string; shortCode: string; totalCents: number; status: OrderStatus }
export function createOrder(input: CreateOrderInput): Promise<CreateOrderResult>
```

- Money: `taxCents = roundHalfUp(subtotal * taxRatePer100k / 100000)`; `lineTotal = (unitPrice + sum(deltas)) * qty`.
  > **Correction, 2026-09-21 (Task 15).** This plan originally wrote the rate as an integer count of
  > **basis points** and used New York City as the example — but NYC prepared food is 8.875%, which is
  > 887.5 bps and is therefore not representable in that unit at all. The column is now
  > `locations.tax_rate_per_100k` (parts per 100,000, 8875 = 8.875%), migrated by
  > `drizzle/0019_tax_rate_per_100k.sql`, which multiplied every existing rate by ten. Every number
  > below that reads "875 bps" is that same 8.75%, now written 8750; the contract order's tax at the
  > real New York rate is **355**, not 350, and its total **4855**.

- [ ] **Step 1: Failing money tests** — `roundHalfUp(174.5) === 175`, `roundHalfUp(174.4) === 174`; an order of 2× (1800 + 200 delta) at the real NYC rate (8875 per 100,000): subtotal 4000, tax 355, tip 500, total 4855 (see the 2026-09-21 correction above).

- [ ] **Step 2: Failing createOrder tests** — (a) happy path: totals exact per Step 1 numbers, status `PENDING_PAYMENT` for card / `NEW` for pay_on_pickup, `menuSnapshotId` set, item `nameSnapshot` equals menu name, an `order_events` row `type='created'`; (b) an 86'd item → throws `ItemUnavailableError`; (c) modifier count below `minSelect` → throws `ModifierSelectionError`; (d) location closed (`isOpenAt` false) → throws `LocationClosedError`.

- [ ] **Step 3: Implement** — inside `withLocation`: load live items+options by id (reject unknown ids), enforce 86/min/max server-side, compute totals in cents, `buildMenuSnapshot`, insert order + items + modifiers + created event in one transaction. No dependency on feed, dashboard, or Stripe (payment intent attaches in Task 9).

- [ ] **Step 4: Green, then commit** — `feat: createOrder isolated write path with server-side validation and exact money math`

---

### Task 9: Stripe direct charges + webhook idempotency

**Files:**
- Create: `src/db/schema/platform.ts` (webhook_events, printers, print_jobs), `src/lib/stripe.ts`, `src/app/api/stripe/webhook/route.ts`, `src/app/api/orders/route.ts`
- Test: `src/app/api/stripe/webhook.test.ts`

**Interfaces:**
- Consumes: `createOrder` (T8), `locations.stripeAccountId` (T2), `canTransition` (T6).
- Produces: `createPaymentIntentFor(order, location): Promise<{ clientSecret: string }>` — `stripe.paymentIntents.create({ amount: order.totalCents, currency: 'usd', automatic_payment_methods: { enabled: true }, metadata: { orderId } }, { stripeAccount: location.stripeAccountId! })`; POST `/api/orders` = createOrder + (card) intent creation, returns `{ orderId, shortCode, clientSecret? }`; webhook route: verify signature (`stripe.webhooks.constructEvent`), **idempotency insert first** (`INSERT INTO webhook_events (provider,'stripe',external_id,event.id) ON CONFLICT DO NOTHING` — zero rows = already processed, return 200), then `payment_intent.succeeded` → order `PENDING_PAYMENT → NEW`, `paymentStatus = PAID`, emit Inngest `order/created`. Also table `printers { id, locationId, provider, serial unique, lastSeenAt }`, `printJobs { id, locationId, orderId, payload text, status enum('queued','delivered','confirmed') , createdAt, confirmedAt }`.
- Env: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (test mode). Tests mock the stripe SDK — no network.

- [ ] **Step 1: Failing webhook tests** — construct a fake event `payment_intent.succeeded` with `metadata.orderId`; (a) first delivery flips the seeded PENDING_PAYMENT order to NEW+PAID and writes a `status_changed` event; (b) the SAME event id delivered again changes nothing (order events count unchanged) and still returns 200; (c) bad signature → 400. Mock `stripe.webhooks.constructEvent` to return the fake event / throw for (c).

- [ ] **Step 2: Implement** per Interfaces. Signature check first, then idempotency insert, then handle. The Inngest emit is a no-op stub until Task 10 (`sendOrderCreated(orderId)` in `src/inngest/client.ts` that Task 10 fills in).

- [ ] **Step 3: Migrate (platform tables) + green.**
- [ ] **Step 4: Commit** — `feat: Stripe direct charges on connected accounts, idempotent webhook`

---

### Task 10: Inngest fan-out (print job + owner SMS)

**Files:**
- Create: `src/inngest/client.ts`, `src/inngest/order-created.ts`, `src/app/api/inngest/route.ts`, `src/lib/sms.ts`
- Test: `src/inngest/order-created.test.ts`

**Interfaces:**
- Consumes: `printJobs` (T9), `renderTicket` (T11 — define the import now, implement there; for this task a placeholder module exporting `renderTicket = (o) => \`ORDER ${o.shortCode}\`` is acceptable **only because Task 11 immediately replaces it — the export name and signature are the contract**), orders repo (T7).
- Produces: Inngest function `orderCreated` on event `order/created { data: { orderId, locationId } }` with **two independent steps**: `step.run('queue-print-job')` inserts a `printJobs` row with the rendered ticket; `step.run('sms-owner')` sends `New order ${shortCode} — $${(totalCents/100).toFixed(2)}. Feed: ${FEED_URL}` to `location.phoneE164` via `sendSms`. `sendSms(to, body)` wraps Twilio REST (env `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_E164`), and is injectable for tests.
- Independence requirement: an SMS failure must not prevent the print job (separate steps = separate retries — assert both run when one throws).

- [ ] **Step 1: Failing tests** using `@inngest/test`'s `InngestTestEngine`: (a) happy path executes both steps, printJobs row exists, sms mock called once with the location phone; (b) sms mock throws → the function reports the step failure but the printJobs row STILL exists.

- [ ] **Step 2: Implement**; wire `sendOrderCreated` (T9 stub) to `inngest.send({ name: 'order/created', data })`; serve route at `/api/inngest`.

- [ ] **Step 3: Green + commit** — `feat: order fan-out via Inngest — print job and owner SMS as independent durable steps`

---

### Task 11: Star CloudPRNT endpoint + ticket renderer

**Files:**
- Create: `src/domain/ticket.ts` (replaces T10 placeholder), `src/app/api/printers/cloudprnt/route.ts`
- Test: `src/domain/ticket.test.ts`, `src/app/api/printers/cloudprnt.test.ts`

**Interfaces:**
- Consumes: `printers`, `printJobs` (T9).
- Produces: `renderTicket(order: OrderWithItems): string` — plain-text 32-col ticket: shortCode huge (`*** ${shortCode} ***`), pickup time, contact name+phone, each line `qty× name` with modifiers indented and `notes` prefixed `>>`, money right-aligned, total last. CloudPRNT protocol on one route: **POST** (printer poll, body `{ printerMAC, statusCode }`) → update `printers.lastSeenAt` (upsert by MAC=serial), respond `{ jobReady: boolean, mediaTypes: ['text/plain'], jobToken? }` for the oldest `queued` job at that printer's location; **GET** `?token=` → the job payload as `text/plain`, mark `delivered`; **DELETE** `?token=&code=OK` → mark `confirmed`, set `confirmedAt`.

- [ ] **Step 1: Failing ticket golden test** — seed an order (2 items, one with 2 modifiers + a note) and compare `renderTicket` output to an exact multi-line string literal (the golden). Keep the golden in the test file.

- [ ] **Step 2: Failing protocol tests** — (a) poll with no jobs → `{ jobReady: false }` and `lastSeenAt` updated; (b) after seeding a queued job: poll → `jobReady: true` + token; GET → body contains the shortCode, job `delivered`; DELETE → `confirmed`; (c) second poll after confirm → `jobReady: false`.

- [ ] **Step 3: Implement both. Green.**
- [ ] **Step 4: Commit** — `feat: CloudPRNT pull endpoint with heartbeat + 32-col ticket renderer`

---

### Task 12: Clerk auth + the feed (API, transitions, minimal tablet page)

**Files:**
- Create: `src/proxy.ts`, `src/app/api/feed/route.ts`, `src/app/api/orders/[id]/transition/route.ts`, `src/app/feed/[location]/page.tsx`, `src/app/feed/[location]/feed-client.tsx`
- Test: `src/app/api/feed.test.ts`, `src/app/api/transition.test.ts`

**Interfaces:**
- Consumes: orders repo (T7), `transition` (T6), `organizations.clerkOrgId` (T2).
- Produces: GET `/api/feed?location=<slug>&since=<iso>` → `{ orders: [...], now: iso }` (orders NEW/ACCEPTED/IN_KITCHEN/READY, full items+modifiers, newest first); POST `/api/orders/:id/transition { to, prepBumpMinutes? }` → applies `transition`, writes the event, `accept` sets `quotedReadyAt = now + prepTimeMinutes + (prepBumpMinutes ?? 0)`; both routes require a Clerk session whose active org's `clerkOrgId` maps to the location's org (403 otherwise). Feed page: server component resolves location + auth; client component polls every 5s (`setInterval`, `since` cursor), renders large cards with Accept (+5/+10/+15 prep bump buttons), Ready, Complete, Reject; a `<audio loop>` chime plays while any order is NEW and unacknowledged (stops on first tap). Ugly is fine; big buttons are not optional.
- Env: `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`. Route tests mock `@clerk/nextjs/server`'s `auth()` (return `{ userId, orgId }`) — no Clerk network in tests.

- [ ] **Step 1: Failing API tests** — (a) feed returns the seeded NEW order with items for the right org's session, 403 for a session whose orgId maps elsewhere; (b) transition NEW→ACCEPTED with `prepBumpMinutes: 10` sets `quotedReadyAt` ≈ now+30min (20 default + 10) and appends the event; NEW→COMPLETED → 422.

- [ ] **Step 2: Implement routes + proxy.ts (clerkProxy wrapper), then the page.** Manual check: `npm run dev`, sign into Clerk dev instance, open `/feed/main`, watch a seeded order appear within 5s.

- [ ] **Step 3: Green + commit** — `feat: authed 5s-polling order feed with transition endpoints and tablet page`

---

### Task 13: 86 / pause endpoints + nightly unsnooze

**Files:**
- Create: `src/app/api/menu/86/route.ts`, `src/app/api/pause/route.ts`, `src/inngest/unsnooze.ts`
- Test: `src/app/api/eighty-six.test.ts`, `src/inngest/unsnooze.test.ts`

**Interfaces:**
- Consumes: menuRepo (T7), `orderPauses` (T5), Clerk guard (T12 — extract `requireLocationAccess(req, locationSlug)` into `src/lib/authz.ts` in this task and reuse it in T12's routes).
- Produces: POST `/api/menu/86 { itemId | modifierOptionId, until: 'tomorrow' | 'manual' }` → sets `is86d = true`, `unsnoozeAt = until === 'tomorrow' ? next 6am location-local : null`; DELETE un-86s. POST `/api/pause { minutes, reason }` → `orderPauses` row; `createOrder` already refuses paused locations (T5/T8). Inngest cron `unsnooze` (`TZ 0 6 * * *` hourly is fine: `0 * * * *` checking `unsnoozeAt <= now`) clears expired 86s on items AND modifier options.

- [ ] **Step 1: Failing tests** — 86 an item until tomorrow → `createOrder` with it throws `ItemUnavailableError`; run the unsnooze handler with `unsnoozeAt` in the past → item orderable again; pause → `createOrder` throws `LocationClosedError` with reason paused.

- [ ] **Step 2: Implement. Green.**
- [ ] **Step 3: Commit** — `feat: two-tap 86 with auto-unsnooze, pause-ordering switch`

---

### Task 14: Stale-order + printer-offline alerting

**Files:**
- Create: `src/inngest/stale-order-alert.ts`, `src/inngest/printer-heartbeat.ts`
- Test: `src/inngest/stale-order-alert.test.ts`

**Interfaces:**
- Consumes: `sendSms` (T10), `isOpenAt` (T5), `printers.lastSeenAt` (T11), order events (T6).
- Produces: on `order/created`… correction — on the order reaching NEW (emit `order/new` from the webhook (card) and from `createOrder` (pay_on_pickup)): `stale-order-alert` waits 6 minutes (`step.sleep`), re-reads the order; still NEW and location open → SMS the restaurant (`phoneE164`); waits 4 more; still NEW → SMS `OPS_ALERT_E164` (env, Rohan's phone). Accepting cancels naturally (the re-read sees ACCEPTED and exits). `printer-heartbeat`: cron every 5 min → any location with a printer whose `lastSeenAt` older than 3 min while `isOpenAt` → SMS owner + ops, at most one alert per hour per printer (`printJobs`-style dedupe table or a `printerAlerts` column `lastAlertAt` on printers — use the column).
- Env: `OPS_ALERT_E164`.

- [ ] **Step 1: Failing tests** with `InngestTestEngine` faking timers: order still NEW after sleep → owner SMS sent; order ACCEPTED before first sleep expires → no SMS. Heartbeat: stale printer at an open location → one SMS; second run within the hour → none.

- [ ] **Step 2: Implement. Green.**
- [ ] **Step 3: Commit** — `feat: escalating stale-order SMS and printer heartbeat alerts`

---

### Task 15: The spine proof — seed Kashi, place-test-order script, README

**Files:**
- Create: `scripts/seed-kashi.ts`, `scripts/place-test-order.ts`, `README.md`
- Modify: `CLAUDE.md` (runbook section)

**Interfaces:**
- Consumes: everything.
- Produces: `npm run seed:kashi` — org "Kashi", one Brooklyn location (tax 8875 per 100,000 = 8.875%, America/New_York, real hours from kashiny.com), a 10-item starter menu with two modifier groups (full 92-item build is Plan 2's Stage 6); `npm run spine:proof` — places a pay-on-pickup order via `createOrder` (no Stripe dependency), then polls `printJobs` until a `queued` job for it exists, prints the rendered ticket to stdout, and exits 0. For the card path it prints instructions: run `stripe listen --forward-to localhost:3000/api/stripe/webhook`, place a card order via the API with test card 4242…, watch it flip to NEW.

- [ ] **Step 1: Write both scripts + run `spine:proof` against the dev database.** Expected stdout ends with the ticket block and `SPINE OK`.
- [ ] **Step 2: README** — what this repo is, the one-paragraph architecture, env table, local dev loop (`npx inngest-cli dev`, `npm run dev`, `stripe listen`), the proof command, pointer to spec + this plan. CLAUDE.md gets the same commands in short form.
- [ ] **Step 3: Full suite green (`npx vitest run`), commit** — `feat: Kashi seed + spine proof script; docs`
- [ ] **Step 4: Create the GitHub repo and push** (`gh repo create RohanSRamnani/serveside --private --source . --push`). Do NOT create a Vercel project yet — deploy is Plan 2's concern.

---

## Self-review notes (done at write time)

- **Spec coverage, stages 1–3:** data layer/tenancy (T2–T7), menu+86+snapshots (T3, T4, T13), internal admin CRUD → deferred to the dashboard plan except the two actions the kitchen needs day one (86/pause, T13) — deliberate; order model + machine (T6, T8), Stripe + idempotency (T9), feed PWA (T12 — PWA manifest deferred to Plan 2 polish; the page works in a tablet browser), printer (T11), SMS fan-out (T10), alerting (T14). Voice, delivery, marketing, customer accounts: out per v1 scope.
- **Deviations from spec, intentional:** `customers` table deferred to Plan 3 (retention) — orders carry contact fields inline (spec's `customer_id` is nullable, so the column exists unused); Sentry/Betterstack wiring lands with deploy in Plan 2. TCPA consent capture ships with the customer-facing checkout (Plan 2) — nothing in this plan sends marketing.
- **Type consistency:** `withLocation` signature identical in T7/T8/T12; `sendSms(to, body)` in T10/T14; `renderTicket` contract pinned in T10, implemented in T11.
