# Serveside

Ordering, kitchen tickets and payments for independent restaurants. A customer orders,
the kitchen's printer spits out a ticket and the owner's phone buzzes, Stripe takes the
money into the restaurant's own account. No POS integration, no commission.

Next 16 (App Router) · Neon Postgres via Drizzle · Stripe Connect · Inngest · Twilio ·
Star CloudPRNT.

## Architecture in one paragraph

Everything is scoped to a **location** (a restaurant address), not to an org, and that
scope is enforced twice: every read or write of a menu, snapshot or order goes through
`withLocation()` (`src/repo/scoped.ts`), which opens a transaction and `SET LOCAL`s
`app.location_id`, and Postgres row-level security refuses anything the GUC does not
match — so the app connects as `app_user`, which owns no tables, or the policies are
silently inert. An order is written by `createOrder()` (`src/domain/create-order.ts`),
which trusts the client for ids and quantities and for nothing that costs money: prices,
modifier deltas, 86 flags and modifier limits are read live, inside the same transaction,
from the location's one active menu, and the order pins the `menu_snapshots` row it was
quoted from so a price dispute six months later has evidence. Money is integer cents
throughout (`src/lib/money.ts`), tax rounded half-up, and the tax rate is an integer in
parts per 100,000 (`locations.tax_rate_per_100k`: 8875 is New York City's 8.875%, which
basis points cannot express). A pay-at-pickup order reaches `NEW`
immediately; a card order sits at `PENDING_PAYMENT` until a **signed** Stripe webhook —
checked against the location's connected account *and* the amount — flips it. Either way
the route sends one `order/created` event and Inngest fans it out (`src/inngest/`) into
two independent legs: render the 32-column ticket and queue it for the printer to collect
by polling, and text the owner. Independent because a jammed printer must not cost the
text and a dead Twilio account must not cost the ticket. The kitchen works from
`/feed/<location>` (Clerk-authed, polls every 5s, chimes); when nobody touches a `NEW`
order for six minutes the restaurant is texted, and four minutes later we are. And every
five minutes a **synthetic canary** (`src/inngest/canary.ts`) places a real one-cent
order at a hidden location, announces it the way the route does and checks a ticket
reached the print queue — two failures in a row text us.

- Spec: `docs/superpowers/specs/2026-09-07-restaurant-ordering-backend-design.md`
- Plan: `docs/superpowers/plans/2026-09-20-ordering-spine.md`
- Conventions, rules and gotchas that matter while editing: `CLAUDE.md`

## Getting a database

Two Neon branches: `main` (dev, `.env.local`) and `test` (the suite, `.env.test`). Both
env files are gitignored; `.env.example` documents every key.

```bash
cp .env.example .env.local          # paste the Neon OWNER url into DATABASE_URL
ENV_FILE=.env.local npm run db:migrate
ENV_FILE=.env.local npm run db:app-user   # moves the owner to MIGRATION_DATABASE_URL,
                                          # points DATABASE_URL at app_user
npm run seed:kashi                        # the pilot restaurant, with its real menu
npm run seed:canary                       # the canary's hidden, synthetic location
```

`db:app-user` is not optional. RLS does not bind a table's owner and the Neon owner also
has BYPASSRLS, so an app connected as the owner has no tenancy at all — `withLocation`
refuses to open a scope for such a role rather than let that pass quietly.

## The proof

```bash
npm run spine:proof
```

Places a real pay-on-pickup order through `createOrder` (real hours check, real menu,
real money, real snapshot pin), drives the real order fan-out, waits for the ticket to
land in the queue a printer polls, prints that ticket and says `SPINE OK`. No Next
server, no Stripe, no Inngest orchestrator — it calls `fanOut()` directly with an inline
`step`, because in production the *route* announces an order and this is deliberately not
an HTTP client. It ends by printing the card-path walkthrough, which is the half that
needs Stripe and a human.

`createOrder` asks the real clock, so with Kashi's real hours the proof only runs between
11am and 10pm New York time. For any other hour:

```bash
npm run seed:kashi -- --hours=always-open   # a development grid, never a restaurant's
npm run seed:kashi                          # puts the real hours back
```

## Local dev loop

```bash
npx inngest-cli dev                                        # discovers /api/inngest
npm run dev                                                # localhost:3000
stripe listen --forward-to localhost:3000/api/stripe/webhook
```

The `whsec_…` the listener prints goes in `STRIPE_WEBHOOK_SECRET` — a dashboard
endpoint's secret is not interchangeable with it and fails every signature with no other
symptom. Inngest needs no account or keys locally.

## Commands

| | |
|---|---|
| `npx vitest run` | the suite. Serial by design — DB tests share the one `test` branch |
| `npm run typecheck` | `next typegen && tsc --noEmit` (bare `tsc` fails: route types) |
| `npm run dev` / `build` / `start` | Next |
| `npm run db:generate` / `db:migrate` | drizzle-kit. `ENV_FILE=.env.local` for `main` |
| `npm run db:app-user` | once per branch, after the first migrate |
| `npm run seed:kashi` | the pilot restaurant. `-- --hours=always-open` for the dev grid |
| `npm run seed:canary` | the canary's synthetic location. Once per database, production included, before the canary's first tick |
| `npm run spine:proof` | the end-to-end proof above |

Never `drizzle-kit push`: it would "correct" every policy, grant, trigger and role, none
of which the schema models.

## Environment

Everything the code actually reads. `env()` throws on a missing or empty value, at the
moment of use rather than at boot, so an unset key fails the one feature that needs it.

| Variable | Read by | Needed for |
|---|---|---|
| `DATABASE_URL` | `src/db/client.ts`, `src/repo/scoped.ts` | everything. **Must be `app_user`** |
| `MIGRATION_DATABASE_URL` | `drizzle.config.ts`, `scripts/seed-kashi.ts` | migrations and seeding — the owner |
| `STRIPE_SECRET_KEY` | `src/lib/stripe.ts` | card orders. The **platform** key, never a connected account's |
| `STRIPE_WEBHOOK_SECRET` | `src/app/api/stripe/webhook/route.ts` | card orders. Must be a **Connect** endpoint's |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | `src/lib/stripe-browser.ts`, `.../checkout/checkout-form.tsx` | the Payment Element. The **platform** publishable key; blank hides the Card option. Inlined at **build** time |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_E164` | `src/lib/sms.ts` | the owner's order SMS and every alert |
| `FEED_URL` | `src/inngest/order-created.ts` | the link in that SMS |
| `OPS_ALERT_E164` | `src/inngest/{stale-order-alert,printer-heartbeat,provenance-refused,canary,stripe-outage-alert}.ts` | our escalation number, in E.164 |
| `SENTRY_DSN` | `src/instrumentation.ts` | server errors to Sentry. **Blank means off** — nothing is initialised |
| `NEXT_PUBLIC_SENTRY_DSN` | `src/instrumentation-client.ts` | browser errors to Sentry; set it to the same DSN. Blank ships no Sentry code at all. Inlined at **build** time |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | `@clerk/nextjs` (`src/proxy.ts`, `src/lib/authz.ts`) | the kitchen feed. Clerk **Organizations must be on** |
| `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` | the Inngest SDK | cloud only; `inngest-cli dev` needs neither |
| `ENV_FILE` | `drizzle.config.ts`, `scripts/*` | which env file a script loads. drizzle-kit defaults to `.env.test`, the seed and proof to `.env.local` |
| `APP_USER_PASSWORD` | `scripts/create-app-user.mjs` | optional; one is generated otherwise |

A pay-at-pickup-only deployment can leave all three Stripe keys blank: `stripe()` is lazy
and nothing reads the secret ones until a card order is placed, and a blank publishable
key simply hides the Card option at checkout. The publishable one is **inlined into the
browser bundle at build time**, so setting it after a deploy changes nothing until the
next build — and a restaurant with no `locations.stripe_account_id` takes no cards
whatever the keys say.

## Tenancy, in one rule

If it belongs to a restaurant, it goes through `withLocation`. The seven tables exempt
from RLS are `organizations`, `locations` and `memberships` (the tenancy root — there is
nothing to scope to until a location exists), `webhook_events` (written before anything
knows whose event it is), `printer_probe_events` (rows that exist *because* the serial
belongs to nobody), and the two platform alarms' ledgers, `canary_runs` and
`payment_failovers` (each answers a platform-wide question). Adding an eighth needs an
argument in `CLAUDE.md` and a line in the catalog assertion in `src/repo/rls.test.ts`.
