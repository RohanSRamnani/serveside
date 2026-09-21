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
- **`menu_snapshots` is insert-only.** Never update or delete a row. `version` is
  `(location_id, version)`-unique and computed inside the INSERT — see `src/domain/snapshot.ts`.
- **`business_hours` is many rows per day, and a row never wraps midnight.** Split
  service is the norm, so nothing may unique on `(location_id, dow)`; post a
  17:00–02:00 shift as two rows (`17:00–24:00` + next dow `00:00–02:00`). `isOpenAt`
  reads wall-clock times in `locations.timezone` — never the server's — treats
  `close_time` as exclusive, and reports **paused > holiday > closed_hours**.

## Commands

- `npx vitest run` — the suite. Serial by design (`fileParallelism: false`): DB tests
  share the single Neon `test` branch, so they are not isolated from each other.
- `npm run typecheck` — `next typegen && tsc --noEmit`. Bare `tsc` fails; `LayoutProps`
  and the other route types only exist after typegen.
- `npx drizzle-kit generate`, then `npm run db:migrate` — drizzle-kit reads no `.env`
  file, so bare `db:migrate` dies on `url: undefined`. Name the branch you mean:
  `DATABASE_URL=$(grep DATABASE_URL .env.test | cut -d= -f2-) npm run db:migrate`.

## Gotchas

- `.env.local` is the Neon `main` branch, `.env.test` is the `test` branch. Both are
  gitignored — do not commit `.env.test` even though the Next docs say to; it holds a
  live connection string.
- `vitest.config.mts`, not `.ts`: this package is CommonJS and Vite's native config
  loader rejects ESM syntax in a `.ts` config.
- `@types/node` stays on `^22` (Node 22, and vitest 5 peer-requires it). The Next
  template's `^20` fails the install.
- `next dev` rewrites the marker block in `AGENTS.md`. Commit the change, don't fight it.
- **neon-http has no transactions**: `db().transaction()` throws at runtime. Make a
  multi-row write atomic with one statement plus a constraint (the version race in
  `src/domain/snapshot.ts`), or `db().batch([...])`.
- Test seeders live in `src/test/seed.ts` (`seedLocation`, `seedLocationWithMenu`) —
  import them; don't re-inline a seeder per test file. Slugs must stay unique: nothing
  tears the test branch down, and `Date.now()` alone collides.
