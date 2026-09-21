@AGENTS.md

# Serveside

Restaurant ordering backend: a customer orders, the kitchen gets a printed ticket,
Stripe takes the money. Next 16 App Router + Neon Postgres via Drizzle.

- Spec: `docs/superpowers/specs/2026-09-07-restaurant-ordering-backend-design.md`
- Plan in flight: `docs/superpowers/plans/2026-09-20-ordering-spine.md`
- `README.md` — what this is, the architecture, the env table, the local loop.

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
  repricing, retiring an item) must rebuild the snapshot **in the same transaction as
  the change**, or the pinned price evidence goes stale while orders keep charging live
  prices.
- **`createOrder` (`src/domain/create-order.ts`) is the order write path, and it trusts
  the client for nothing but ids and quantities.** Prices, deltas, 86 flags and the
  effective modifier limits (`minOverride ?? group.minSelect`) are read live inside the
  same transaction that writes the order, and only from the location's **one active
  menu** — the universe `buildMenuSnapshot` roots at, so nothing can be sold that the
  pinned snapshot could not contain. Zero or two active menus rejects the order rather
  than falling back on the last good snapshot. Every id from the request is shape-checked
  as a uuid first: a malformed one is 22P02, which poisons the transaction. Money is `src/lib/money.ts`: integer cents,
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
  day RLS stops working. **Two deliberate exceptions**, both taking an explicit
  `locationId`: `ordersRepo.listActiveWithItems` and `ordersRepo.lockById` — the
  kitchen board and the row a tablet is about to move. RLS is *silently inert* for a
  role that owns the tables, and an env file pointed at the Neon owner is one command
  away, so the two reads whose output reaches a browser say "whose is this" in SQL too.
  `repos.test.ts` pins that by scoping a transaction to location B and asking for
  A — RLS allows B's rows, so anything returned is the predicate having gone missing.
  Adding a third needs the same argument and the same shape of test. Unscoped means
  *no rows*, never all rows. `withLocation`
  refuses to open a scope at all if `DATABASE_URL` connects as a role that bypasses
  RLS — the failure is otherwise silent. The leak test `src/repo/rls.test.ts` is the
  proof and must never be weakened: one case asserts the **exact** set of
  RLS-enabled tables, so a new table fails there by name until it is policied or
  consciously exempted.
- **There is exactly one way around RLS, and it is `printer_lookup`** — a
  SECURITY DEFINER function (`drizzle/0012_printer_lookup.sql`) that turns a printer
  serial into `(printer_id, location_id)` and nothing else. It exists because a Star
  CloudPRNT printer can only present the MAC burnt into it, and the location that
  would scope a read of `printers` is the very thing being looked up. Safe because
  the serial *is* the credential, it returns only ids (no row, no enumeration), an
  unknown serial returns zero rows so nothing can register itself, and everything
  after it is ordinary `withLocation` code. Its `search_path` is pinned, EXECUTE is
  revoked from PUBLIC, and `rls.test.ts` asserts it is still the *only* such
  function — a second bypass has to be argued for there, by name. Its mechanism is
  that the owner is not bound by RLS, so **never add `FORCE ROW LEVEL SECURITY` to
  `printers`**: every kitchen would stop printing, silently.
- **A new table under RLS needs three things, not one**: `.enableRLS()` in the
  drizzle schema (or `push` would disable the policy — see Commands), `CREATE POLICY`
  and an explicit `GRANT` in its migration (`app_user` has no default privileges),
  and its name added to the catalog assertion in `rls.test.ts`.
- **Stripe is Connect Standard with direct charges, and the `{ stripeAccount }`
  option is the entire mechanism.** The charge is created *on the restaurant's*
  account, so they are merchant of record, funds settle to them, and we are not a
  money transmitter. Never separate charges + transfers, never destination charges.
  `amount` is `order.totalCents` verbatim — never recomputed here, or the charge and
  the receipt get two arithmetic paths to disagree on. A location with no
  `stripeAccountId` cannot take cards (`StripeAccountMissingError` → 503); pay-at-pickup
  is unaffected. `createPaymentIntentFor` puts **both** `orderId` and `locationId` in
  the intent metadata: the webhook has no scope of its own and RLS hides the order
  from it without the second one.
- **The webhook's order of operations is the design: verify signature → claim the
  event → handle.** The claim is `INSERT INTO webhook_events ... ON CONFLICT DO
  NOTHING` on `external_id`; zero rows back means a duplicate delivery, answer 200 and
  stop. Stripe *will* deliver twice. Claiming before verifying would let anyone with
  the URL burn an event id; verifying after parsing `req.json()` would verify bytes
  Stripe never signed, so the body is read with **`req.text()`**. Handling failure
  releases the claim and returns 5xx so the retry lands on a clean id.
- **Stripe retries every 5xx forever, so 200 is the answer to anything a retry cannot
  fix** — an order already past PENDING_PAYMENT, an event type we ignore, metadata
  that names no order. Those are logged, not raised. 5xx is only for failures a retry
  could genuinely repair. A **config fault is one of them**: the signing secret and the
  client are read *outside* the verification `try`, because caught by it a blank
  `STRIPE_WEBHOOK_SECRET` would answer every real payment `400 invalid_signature` and
  silently flip nothing.
- **One "already done" state is not done: NEW + PAID + holding *this* intent, flipped
  within 24h.** That is the fingerprint of a flip we made whose fan-out never landed —
  the fan-out runs after the commit, so a crash or a 500 in between loses it — and the
  webhook **re-fires `sendOrderCreated`** rather than shrugging, or every later delivery
  finds a legal state and nobody is ever told. Every conjunct earns its place: a
  pay-at-pickup order is NEW and paid too, a CANCELED one must never be re-announced,
  and a REFUNDED one is still NEW and still holds its intent. The 24h bound is Inngest's
  dedupe window — inside it a re-fire is free (rescue, or silently dropped), outside it
  the SMS leg would text the owner about yesterday's order, and Stripe retries for three
  days. Age comes from the flip's own `payment_succeeded` event; no such row means the
  flip was not ours, so it is not re-announced.
- **A signed event proves Stripe sent it, not whose money it is.** Every restaurant on
  the platform has a connected account and can mint an intent with any metadata, so
  the flip additionally requires `event.account === location.stripeAccountId` and
  `intent.amount === order.totalCents` (and, when the order already holds one, a
  matching intent id). All three are log-and-200 no-ops on mismatch. The **first two
  also emit `payments/provenance-refused`**, which texts `OPS_ALERT_E164`: they catch
  something being *attempted*, and a `console.error` on a serverless function is not an
  alarm. Sent after the transaction, keyed on the Stripe event id so three days of
  retries ring one phone. The intent-mismatch branch is deliberately silent — an order
  can only hold a second intent because we made one, so it is our bug, not a stranger's
  money.
  **Deployment consequence:** the endpoint must be registered as a **Connect** webhook
  on the platform account — that is what populates `event.account`. Registered on a
  connected account it is absent, and every flip becomes a logged no-op.
- **The `PENDING_PAYMENT → NEW` flip sets three things together**: `status`,
  `paymentStatus = 'PAID'`, and `quotedReadyAt = <flip time> + location.prepTimeMinutes`.
  The clock starts when the money lands, not at checkout — a promise made while the
  customer is still typing a card number has an unknown amount of it already spent.
- **The kitchen printer polls us, and the serial is the whole of its identity.**
  `/api/printers/cloudprnt` is unauthenticated by protocol — a thermal printer has no
  session to hold. POST is the poll and the heartbeat; GET hands over the payload and
  marks `delivered`; DELETE with `code=OK` marks `confirmed`. **All three carry the
  MAC** (Star sends it on the query string too), because that is what makes a
  `jobToken` redeemable only in the context that was offered it — a token from another
  restaurant is a 404 with an empty body, never a 403. An unknown serial is answered
  `jobReady: false` and **creates no printer**: auto-registration would let anyone who
  can reach the URL claim a location and collect its tickets. A non-OK `code` leaves
  the job at `delivered` rather than requeuing it — a jammed printer would otherwise
  fail the same ticket forever and never reach the orders behind it. **The open risk is
  serial enumeration**: the OUI is public and vendors burn MACs sequentially, so a hit
  steals a ticket (name + phone) and can confirm it so it never prints. The serial is
  clamped to a plausible shape before it is queried or logged, and the one thing an
  unknown one now writes is an upserted `printer_probe_events` row (no `location_id`,
  no path into `printers`) that the heartbeat cron counts — **capped**: one row per
  serial, and no new serials at all once the window is already over the alerting
  threshold, so a sweep cannot choose how big that table gets. **The poll path is
  deliberately not rate-limited** — a whole restaurant shares one NAT and a real
  printer polls forever, so a limiter tight enough to slow a sweep eventually refuses a
  kitchen's ticket; the argument is written at the head of the route, and a limiter, if
  ever wanted, belongs at the CDN.
- **The order fan-out (`src/inngest/order-created.ts`) is two INDEPENDENT steps, and
  that independence is the point.** `queue-print-job` and `sms-owner` run under one
  `Promise.allSettled`, so a jammed printer still texts the owner and a dead Twilio
  account still queues the ticket — never sequential, which would make the SMS wait out
  the print leg's whole retry ladder. Each leg re-reads the order inside its own
  `withLocation`; nothing about the order travels in the event (ids only — an event
  payload lives in Inngest's dashboard). The run still **throws** when a leg fails, or a
  half-done fan-out would show green. **Idempotent three ways**, because all three are
  needed: the event id (`order-created-${orderId}`) dedupes a re-fire for 24h, the print
  leg skips when a job for the order already exists, and a `pg_advisory_xact_lock` on
  the order id makes that check-then-insert safe — Inngest steps are *at-least-once* and
  can genuinely run twice, concurrently. The SMS leg is deliberately **not** deduped: a
  duplicate text is a nuisance, a duplicate ticket is food.
- **`renderTicket` (`src/domain/ticket.ts`) runs once, at fan-out, and its output is
  stored verbatim** in `print_jobs.payload` — same reasoning as `orders.menu_snapshot_id`:
  a reprint must reproduce the ticket that printed, not re-render against a menu that
  has moved. 32 columns, hard: the printer drops a 33rd character rather than wrapping
  it, so the renderer wraps everything itself and truncates nothing — otherwise a dish
  loses the half of its name that said "no peanuts". Takes the location's
  `timezone` because a ticket prints the restaurant's wall clock, never the server's,
  and that column is not on the order row. `src/domain/ticket.test.ts` pins the exact
  output — change the layout and you change the golden, deliberately.
- **Every path that reaches NEW must send `order/created`, and there are two.** The
  Stripe webhook after the flip, and `POST /api/orders` for a pay-at-pickup order,
  which `createOrder` writes straight to NEW. The second was missing until Task 14:
  those orders were never rendered, never queued for a printer and never texted about —
  they existed only on the kitchen feed. The route gates on the **status `createOrder`
  returned**, not the payment mode, and a failure there is logged and still answers
  200: the order is already committed, and a 500 would make the customer's retry a
  second dinner. Safe because `sendOrderCreated` is idempotent per order.
- **The alarms page the RESTAURANT first and us second, and never for a closed
  restaurant.** Three functions, all in `src/inngest/`:
  - `stale-order-alert` rides `order/created` alongside the fan-out (two functions, one
    event). `step.sleep` 6m → still NEW and `isOpenAt` → text the owner "tap Accept";
    4m more → still NEW and open → text `OPS_ALERT_E164`. Accepting cancels it by
    itself: each leg re-reads the order, so there is no cancel signal to go wrong. The
    minutes in the message are the **thresholds, not elapsed since `createdAt`** — a
    card order's checkout can precede the kitchen hearing about it by minutes.
  - `printer-heartbeat`, cron `*/5 * * * *`: a printer whose `lastSeenAt` is older than
    3 minutes, or a `print_job` stuck at `delivered` **between 10 minutes and 6 hours**,
    texts owner **and** ops in one message, at most once an hour per printer via
    `printers.lastAlertAt`. A NULL `lastSeenAt` is a unit never plugged in, not a fault.
    The **upper bound is load-bearing**: nothing ever moves a job off `delivered`, so an
    open-ended predicate would text about one jammed ticket every open hour forever.
    Stuck jobs are **never requeued** — the printer may have printed it and died before
    saying so. Sends *then* stamps, and stamps if **either** phone answered. **The
    sweep step never throws**: everything that went wrong comes back in its result and
    the **run** is failed from the function body. A step-level failure would be retried,
    and the retry cannot rediscover anything — the alerts that went out stamped their
    cooldown — so it would come back green. `OPS_ALERT_E164` is one number for the whole
    platform, so a broken one fails every alerting restaurant in the same tick; throwing
    on the first of them would discard the rest. The next cron tick is the retry for
    anything that raised no alarm at all, which stamps nothing.
  - `provenance-refused-alert` on `payments/provenance-refused` — ops only; see the
    Stripe provenance rule above.
  Its second leg owns `printer_probe_events` (`src/domain/printer-probes.ts`, shared
  with the poll route): >20 distinct unknown serials in 10 minutes texts ops once an
  hour, and the same leg prunes rows older than 24h. **The route stops recording new
  serials once the window is over threshold**, so the count is a floor ("at least N")
  and the table cannot be grown at will by a stranger. Both legs run under
  `Promise.allSettled`, so one restaurant's database trouble cannot hide a sweep.
- **`withLocation` is scoping, not authorization, and the check that is authorization
  is `requireLocationAccess` (`src/lib/authz.ts`).** It runs *before* a scope opens and
  resolves one chain: the Clerk session's active org → `organizations.clerk_org_id` →
  that org's own location with this slug. **Org first, slug second** — `locations.slug`
  is unique per org (`locations_org_slug_unique`) and not globally, so a slug-first
  lookup is a coin toss between tenants. "Not yours" and "nobody's" are the same 403
  with the same body, so the route cannot be used to enumerate restaurants; a page
  branches on `status === 401` to send someone to sign in. Every authed surface —
  the feed, the transition buttons, Task 13's 86/pause — goes through it.
- **`src/proxy.ts` (Next 16's `middleware.ts`) authorizes nothing.** It attaches the
  Clerk session so `auth()` can read it, and that is all; `createRouteMatcher` is
  deprecated in `@clerk/nextjs` 7 precisely because path matching drifts from routing
  and fails open. Its `matcher` **excludes** `/api/stripe/`, `/api/printers/`,
  `/api/inngest` and `POST /api/orders` — those are authenticated by a signature, a
  MAC, a signing key and nothing, and `clerkMiddleware()` throws on a missing
  publishable key, so left in, one blank env var stops a kitchen printing. The matcher
  must be **one string literal**: Next extracts it by static analysis, and a
  concatenation is silently dropped, which looks exactly like the exclusions not working.
- **The feed's `since` is a floor, not a cursor.** `GET /api/feed?location=&since=`
  returns the whole active set (`KITCHEN_STATUSES`) inside the window, newest first;
  the tablet fixes `since` at load−12h and never advances it, because the change that
  matters between two polls is an order *already on the board* moving to ACCEPTED or
  READY. An advancing cursor returns an empty array all afternoon. `now` in the
  response is the server's clock — every elapsed time is computed against it, never
  the tablet's. The client's `pollBanner(status)` separates **a dead session from dead
  wifi** and must keep doing so: a signed-out board can never chime again (no poll, no
  new order, no sound), so silence stops meaning "nothing to cook" — 401/403 gets a
  full-width bar, everything else a corner chip.
- **`POST /api/orders/[id]/transition` takes the location on the query string**
  (`?location=<slug>`), because an order id alone cannot be read at all: `orders` is
  under RLS and the scope has to be chosen before the first SELECT. Body is
  `{ to, prepBumpMinutes?, reason? }`. `ACCEPTED` sets `quotedReadyAt = now +
  prepTimeMinutes + bump` (prep time re-read **on the tx**), `READY`/`COMPLETED`/
  `CANCELED` stamp their columns; `IN_KITCHEN` and `REJECTED` have no column and the
  `order_events` row is their record. A move the machine refuses is 422
  `illegal_transition` naming both ends — including a double-tap, since the machine
  has no status-to-itself edge. **It refuses any order not already in
  `KITCHEN_STATUSES`** (422 `not_on_the_board`): `PENDING_PAYMENT → NEW` is a legal
  edge but belongs to the Stripe webhook alone, which flips status, `paymentStatus`
  and `quotedReadyAt` together — done by hand it puts unpaid food on a pass *and*
  leaves a row the webhook no longer recognises as its own, so the real payment later
  flips nothing. **Rejecting or cancelling a PAID order moves no money** — the customer
  stays charged until the dashboard refund flow exists (spec §4); the owner refunds in
  Stripe by hand until then. `TODO(plan-2/refunds)` marks it in the route.
- **`business_hours` is many rows per day, and a row never wraps midnight.** Split
  service is the norm, so nothing may unique on `(location_id, dow)`; post a
  17:00–02:00 shift as two rows (`17:00–24:00` + next dow `00:00–02:00`), which a
  `close_time > open_time` CHECK enforces — a wrapped row would close the day. `isOpenAt`
  reads wall-clock times in `locations.timezone` — never the server's — treats
  `close_time` as exclusive, and reports **paused > holiday > closed_hours**.
- **The 86 button undoes itself, and every 86 rebuilds the snapshot in the same
  transaction as the toggle.** `POST /api/menu/86?location=<slug>`
  `{ itemId | modifierOptionId, until: 'tomorrow' | 'manual' }`; `DELETE` puts it back
  and clears the deadline with the flag. `'tomorrow'` stores
  `nextLocalHour(now, location.timezone, 6)` — 6am *at the restaurant*, DST-safe;
  `now + 24h` would put a dish 86'd at 9pm back a whole service late. The hourly
  Inngest cron `unsnooze` (`0 * * * *`, **UTC** — every restaurant has its own 6am,
  what they share is an instant) clears `unsnooze_at <= now` on items **and** modifier
  options and rebuilds each affected location's snapshot in that location's
  transaction. An indefinite 86 has `unsnooze_at` NULL and survives for free
  (`NULL <= now` is NULL, not true). It scans **every** location, because
  `menu_items` carries no `location_id` and an unscoped read under RLS returns
  nothing — fine into the low hundreds; past that the fix is a second SECURITY
  DEFINER function, which has to be argued for by name in `rls.test.ts`. Two steps
  per run, never one per location: that would be `locations × 24 × 30` steps a month
  of almost entirely nothing, and per-location retries come free from the clear being
  the state change the rebuild is gated on. **A function not in
  `src/inngest/functions.ts` is never invoked**, and a cron has no event to go missing.
- **`POST /api/pause?location=<slug>` `{ minutes, reason? }` is the "we're slammed"
  switch**, and `DELETE` resumes by **shortening every live row's `until` to now** —
  not deleting it, and not inserting a row with a past `until`: `isOpenAt` reports
  paused if *any* row has `until > now`, so a new row cannot cancel an old one, and
  two taps in a rush is two rows. `created_by` is the Clerk user id; null there means
  the system paused it, which must stay tellable apart.

## Commands

- `npx vitest run` — the suite. Serial by design (`fileParallelism: false`): DB tests
  share the single Neon `test` branch, so they are not isolated from each other.
- `npx inngest-cli dev` — the local orchestrator. No account, no keys: it discovers
  `/api/inngest`, runs the fan-out for real and shows each step and its failures.
  `INNGEST_EVENT_KEY` / `INNGEST_SIGNING_KEY` are cloud-only.
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
- `npm run seed:kashi` — the pilot restaurant (org `kashi`, one Brooklyn location),
  with **their real menu, prices and hours**, copied from
  `client-sites/src/clients/kashi/config.ts`. Upserts on natural keys, so it is safe to
  re-run, and its last act is `buildMenuSnapshot` — a seeded location is immediately
  orderable. `ENV_FILE=.env.test` seeds the test branch; `-- --hours=always-open` posts
  an around-the-clock **dev** grid (never a restaurant's) so the proof and the suite are
  not stuck behind opening time. Plain `npm run seed:kashi` puts the real hours back.
- `npm run spine:proof` — the end-to-end proof: a real pay-on-pickup order through
  `createOrder`, the real `fanOut` driven with an inline `step`, then it polls
  `print_jobs` and prints the rendered ticket, ending `SPINE OK`. Needs `DATABASE_URL`
  on `app_user` (it says so, with the fix, if not) and a seeded restaurant.
- The local loop is three terminals: `npx inngest-cli dev`, `npm run dev`, and
  `stripe listen --forward-to localhost:3000/api/stripe/webhook` — whose `whsec_…` goes
  in `STRIPE_WEBHOOK_SECRET`. `README.md` has the env table and the card walkthrough.
- Triggers, RLS, roles — anything drizzle-kit does not model — go in a hand-written
  migration: `npx drizzle-kit generate --custom --name=<what>`, fill the file, migrate
  as above. `generate` afterwards must still say "No schema changes". Write them
  idempotently (`DROP POLICY IF EXISTS`, `IF NOT EXISTS`): Neon branches get reset.
- **Never `drizzle-kit push`.** It diffs the live database against the schema and
  "corrects" anything the schema does not model — which is every policy, grant,
  trigger and role in this repo. `generate` + `migrate`, always.

## Gotchas

- **`withLocation` commits on a return and rolls back only on a throw.** A refusal
  decided *after* a write — the 86 route's `menu_unavailable`, which it can only know
  once the toggle has run — must be **thrown** out of the callback and caught by the
  route, or the write it meant to undo is committed. Checking beforehand instead would
  also make the atomicity test pass against a route that used two transactions.
- `.env.local` is the Neon `main` branch, `.env.test` is the `test` branch. Both are
  gitignored — do not commit `.env.test` even though the Next docs say to; it holds a
  live connection string. `TWILIO_*` are deliberately **absent** from `.env.test`,
  unlike the Stripe placeholders: the suite mocks `sendSms`, so a test that reaches the
  real one has forgotten to — and with no credentials that is a loud `env()` throw
  instead of a text message sent from CI.
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
- **Exempt from RLS, on purpose and only these five**: `organizations`, `locations`,
  `memberships` — the tenancy root, with nothing to scope to until a location exists —
  `webhook_events`, which must be written before anything knows whose event it is
  (the tenant is inside the payload, and scoping to a location read out of an
  unverified body would be scoping to whatever the caller claimed), and
  `printer_probe_events`, whose rows exist *because* `printer_lookup` placed the serial
  with nobody: there is no tenant to scope to at all. `memberships` is the one worth
  revisiting; it maps Clerk user ids to orgs.
- A migration that adds a CHECK validates rows already on the `test` branch, and
  nothing ever deletes them — a RED run that wrote the now-illegal row blocks the
  migration. Delete the offending rows, then migrate.
- `order_items` has **no sort column**, so the order a customer built their cart in is
  not recoverable. `ordersRepo.getWithItems` sorts by name so a ticket at least reads
  the same on every reprint; `gen_random_uuid()` order would reshuffle it. Add a `sort`
  column and this should follow the cart.
- Test seeders live in `src/test/seed.ts` (`seedLocation`, `seedLocationWithMenu`,
  `seedBusinessHours`, `seedPaidOrder`, `seedCardOrder`, `seedTicketOrder`,
  `seedPrinter`, `seedPrintJob`, `linkClerkOrg`, `quietProbeWindow`) — import them;
  don't re-inline a seeder per test file. `seedCardOrder` is the PENDING_PAYMENT /
  REQUIRES_PAYMENT order the Stripe webhook flips; `seedPaidOrder` is the one already at
  NEW / PAID. Slugs must stay unique: nothing tears the test branch down, and `Date.now()`
  alone collides. `seedBusinessHours` defaults to `OPEN_ALL_WEEK`, which is what a test
  of `createOrder` needs: it asks `isOpenAt(new Date())`, so hours pinned to one weekday
  would only pass on that weekday. **Any test that touches `printer_probe_events` calls
  `quietProbeWindow()` first** — that table is platform-global with nothing to scope to,
  so one file's leftover probes change another file's answers (both the burst count and
  the route's recording cap read the same ten-minute window).
- **Inngest 4 is not the API you remember.** It is
  `createFunction({ id, triggers: { event } }, handler)` — one options object, two
  arguments. The v3 three-argument form throws at import, and `EventSchemas` is gone
  (v4 has `eventType()` over a Standard Schema; we shape-check ids by hand instead, the
  way the Stripe webhook does).
- **`@inngest/test` is a harness, not the orchestrator**, and two differences bite.
  It settles a run the moment a step errors, while the sibling step is still mid-write
  — so an assertion about the *other* leg has to wait (`vi.waitFor`), and a stray step
  can land during the next test (hence per-test phone numbers in
  `order-created.test.ts`). And it re-executes steps whose results have not reached its
  shared state, so step call *counts* are not pinnable; assert side effects and
  arguments. A mocked step that throws is **not** delivered to the function body, so the
  "a leg exhausted its retries" path cannot be driven through the harness at all — hence
  `fanOut(data, step)` is exported and called directly with a two-line fake `step`,
  which is also the only crisp way to race the print leg against itself.
- **Clerk needs Organizations turned on in the dashboard**, or every session has a
  null `orgId`, `requireLocationAccess` 403s everything, and the feed is a refusal
  page with no error anywhere explaining it. With `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
  blank, `clerkMiddleware()` throws and every proxied route 500s — loud on purpose,
  and the reason the machine-facing routes are excluded from the matcher.
- **React components are tested with `renderToStaticMarkup`, not a DOM.** No jsdom, no
  testing-library: `src/app/feed/feed-client.test.tsx` renders the card to a string and
  asserts the dish, its modifiers, both notes and the tap-target sizes; `page.test.tsx`
  calls the async server component as the ordinary function it is
  (`await FeedPage({ params })`) and renders its element, which covers segment →
  authz → scoped read → first paint against the real database. `useEffect` never runs,
  so the 5s poll, the chime's autoplay unlock and anything needing layout are **not**
  covered by any test — they are the manual check.
- `public/chime.wav` is generated, not sourced: `node scripts/make-chime.mjs`.
- **Route handlers are tested by importing and calling them**, not through a server:
  `const { POST } = await import('./webhook/route')`, then `POST(new Request(...))`.
  They take a Web `Request` and return a Web `Response`, with nothing imported from
  `next/server`, which is what keeps that possible. Tests mock the Stripe SDK whole
  (`vi.mock('stripe', ...)` over `vi.hoisted` fns) — no network, and `constructEvent`
  is the seam for a valid vs. forged signature.
- **`scripts/seed-kashi.ts` is the one code path that connects as the owner**, and it
  says why: seeding writes a location's menu before there is a tenant to scope to, so
  `withLocation` would refuse it. It opens its own transaction and sets the GUC itself
  (`ownerScope`), reads `MIGRATION_DATABASE_URL`, and refuses to run as a role RLS
  binds. Nothing else may copy it — `spine:proof` deliberately goes through the ordinary
  `app_user` path, which is what keeps the exemption to one file.
