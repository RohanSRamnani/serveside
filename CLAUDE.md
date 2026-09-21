@AGENTS.md

# Serveside

Restaurant ordering backend: a customer orders, the kitchen gets a printed ticket,
Stripe takes the money. Next 16 App Router + Neon Postgres via Drizzle.

- Spec: `docs/superpowers/specs/2026-09-07-restaurant-ordering-backend-design.md`
- Plan in flight: `docs/superpowers/plans/2026-09-20-ordering-spine.md`

## Non-negotiable rules

- **All money is `bigint` cents, never floats.** Drizzle: `bigint({ mode: 'number' })`.
- **Menus, hours and orders scope to `location_id`, not `org_id`.** Every domain
  table carries one. One missing WHERE clause must not leak another restaurant's orders.
- **Order rows snapshot names and prices.** Never join a historical order to a live menu item.
  `orders.menu_snapshot_id` is NOT NULL — every order pins the menu it was quoted from,
  and the FK is composite, `(location_id, menu_snapshot_id)`, so it can only ever pin
  one of its own location's snapshots.
- **`order_events` is append-only**, and a trigger enforces it: UPDATE, DELETE and
  TRUNCATE all raise. Every state change appends one. The legal moves are
  `src/domain/order-status.ts` (`transition` returns the event to insert with it, and
  COMPLETED/REJECTED/CANCELED are terminal — undo a completed order with a refund, not
  a walk back up the machine).
- **`menu_snapshots` is insert-only.** Never update or delete a row. `version` is
  `(location_id, version)`-unique and computed inside the INSERT — see `src/domain/snapshot.ts`.
  Orders pin the **current** snapshot (`getOrBuildCurrentSnapshot`), never a fresh build
  per order — so anything that changes what may be ordered or what it costs (86'ing,
  repricing, retiring an item) must rebuild the snapshot, or the pinned price evidence
  goes stale while orders keep charging live prices.
- **`createOrder` (`src/domain/create-order.ts`) is the order write path, and it trusts
  the client for nothing but ids and quantities.** Prices, deltas, 86 flags and the
  effective modifier limits (`minOverride ?? group.minSelect`) are read live inside the
  same transaction that writes the order. Money is `src/lib/money.ts`: integer cents,
  tax rounded **half-up, never banker's**, and `subtotal + tax + tip + fee − discount
  = total` asserted on the row itself immediately before the INSERT. Customer-facing
  rejections are the `OrderRejectedError` family, each with a `code` for the HTTP layer;
  a plain `Error` out of here is our bug, not the customer's.
- **Tenancy is enforced twice: by `withLocation` and by Postgres RLS.** Every read
  or write of a location's menus, snapshots or orders goes through
  `withLocation(locationId, fn)` (`src/repo/scoped.ts`) — a websocket-pool
  transaction that `SET LOCAL`s `app.location_id`, which the policies in
  `drizzle/0008_rls_tenancy.sql` read. Repos (`ordersRepo`, `menuRepo`) therefore
  carry **no** `location_id` filter of their own; writing one back would hide the
  day RLS stops working. Unscoped means *no rows*, never all rows. `withLocation`
  refuses to open a scope at all if `DATABASE_URL` connects as a role that bypasses
  RLS — the failure is otherwise silent. The leak test `src/repo/rls.test.ts` is the
  proof and must never be weakened: one case asserts the **exact** set of
  RLS-enabled tables, so a new table fails there by name until it is policied or
  consciously exempted.
- **A new table under RLS needs three things, not one**: `.enableRLS()` in the
  drizzle schema (or `push` would disable the policy — see Commands), `CREATE POLICY`
  and an explicit `GRANT` in its migration (`app_user` has no default privileges),
  and its name added to the catalog assertion in `rls.test.ts`.
- **`business_hours` is many rows per day, and a row never wraps midnight.** Split
  service is the norm, so nothing may unique on `(location_id, dow)`; post a
  17:00–02:00 shift as two rows (`17:00–24:00` + next dow `00:00–02:00`), which a
  `close_time > open_time` CHECK enforces — a wrapped row would close the day. `isOpenAt`
  reads wall-clock times in `locations.timezone` — never the server's — treats
  `close_time` as exclusive, and reports **paused > holiday > closed_hours**.

## Commands

- `npx vitest run` — the suite. Serial by design (`fileParallelism: false`): DB tests
  share the single Neon `test` branch, so they are not isolated from each other.
- `npm run typecheck` — `next typegen && tsc --noEmit`. Bare `tsc` fails; `LayoutProps`
  and the other route types only exist after typegen.
- `npx drizzle-kit generate`, then `npm run db:migrate`. `drizzle.config.ts` loads the
  env file itself now — `.env.test` by default, `ENV_FILE=.env.local` for `main` — and
  migrates as `MIGRATION_DATABASE_URL` (the owner). `DATABASE_URL` is `app_user` and
  could not create a table if it tried.
- `npm run db:app-user` — once per Neon branch, right after the first migrate. Sets
  `app_user`'s password (from `APP_USER_PASSWORD`, else generated), verifies the role
  cannot bypass RLS, and rewrites the env file's `DATABASE_URL`. Never prints a secret.
  The password is deliberately not in the committed migration.
- Triggers, RLS, roles — anything drizzle-kit does not model — go in a hand-written
  migration: `npx drizzle-kit generate --custom --name=<what>`, fill the file, migrate
  as above. `generate` afterwards must still say "No schema changes". Write them
  idempotently (`DROP POLICY IF EXISTS`, `IF NOT EXISTS`): Neon branches get reset.
- **Never `drizzle-kit push`.** It diffs the live database against the schema and
  "corrects" anything the schema does not model — which is every policy, grant,
  trigger and role in this repo. `generate` + `migrate`, always.

## Gotchas

- `.env.local` is the Neon `main` branch, `.env.test` is the `test` branch. Both are
  gitignored — do not commit `.env.test` even though the Next docs say to; it holds a
  live connection string.
- `vitest.config.mts`, not `.ts`: this package is CommonJS and Vite's native config
  loader rejects ESM syntax in a `.ts` config.
- `@types/node` stays on `^22` (Node 22, and vitest 5 peer-requires it). The Next
  template's `^20` fails the install.
- `next dev` rewrites the marker block in `AGENTS.md`. Commit the change, don't fight it.
- **Two drivers, and the choice is not stylistic.** `db()` is neon-http: stateless,
  no session, no transactions (`db().transaction()` throws), so it can never carry
  the RLS scope — it is for the three tables that are not location-scoped
  (`organizations`, `locations`, `memberships`). A scoped transaction may read those
  three as well, and `createOrder` reads `locations` on its own `tx` so the tax rate
  it prices with is the one in force when the order is written.
  `withLocation` is neon-serverless over a websocket Pool. Node 22 supplies the
  global `WebSocket`, so `ws` is not a dependency.
- `buildMenuSnapshot(locationId, tx?)` and `isOpenAt(locationId, at, tx?)` open
  their own scope when given no `tx`, so a checkout can run both plus its writes in
  one transaction and see one consistent database.
- A failed statement poisons its whole transaction (25P02), so a retry inside
  `withLocation` must wrap the attempt in `tx.transaction()` — a SAVEPOINT — as the
  snapshot version race does. Retrying in place only turns one error into another.
- `current_setting('app.location_id', true)` returns `''`, not NULL, once any
  transaction on that pooled backend has set it. Policies use
  `nullif(current_setting(...), '')::uuid` for that reason; the bare cast raises
  22P02 on every unscoped query instead of quietly matching nothing.
- **Exempt from RLS, on purpose and only these three**: `organizations`, `locations`,
  `memberships` — the tenancy root, with nothing to scope to until a location exists.
  `memberships` is the one worth revisiting; it maps Clerk user ids to orgs.
- A migration that adds a CHECK validates rows already on the `test` branch, and
  nothing ever deletes them — a RED run that wrote the now-illegal row blocks the
  migration. Delete the offending rows, then migrate.
- Test seeders live in `src/test/seed.ts` (`seedLocation`, `seedLocationWithMenu`,
  `seedBusinessHours`, `seedPaidOrder`) — import them; don't re-inline a seeder per test
  file. Slugs must stay unique: nothing tears the test branch down, and `Date.now()`
  alone collides. `seedBusinessHours` defaults to `OPEN_ALL_WEEK`, which is what a test
  of `createOrder` needs: it asks `isOpenAt(new Date())`, so hours pinned to one weekday
  would only pass on that weekday.
- `.env.local` still points `DATABASE_URL` at the owner. Migrate `main` and run
  `ENV_FILE=.env.local npm run db:app-user` before anything serves real traffic —
  until then the app bypasses its own RLS on that branch.
