# Storefront Implementation Plan (Plan 2 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A customer on a phone can browse Kashi's real menu, build a cart, pay with a card (or choose pay-at-pickup), and watch their order's status — spec stages 4–7: storefront, ops instrumentation, the full Kashi menu, launch readiness.

**Architecture:** Customer routes live in the same `serveside` app under `/order/[location]`. Menu browse renders from the location's LATEST `menu_snapshots` row — never live tables — so browsing survives a database write-path outage and always agrees with what orders pin. Cart is client state; every rule it enforces is re-enforced by `createOrder` server-side (already true, Plan 1). Payment is Stripe Payment Element on the connected account (direct charges): the platform publishable key initialized with the `stripeAccount` option, `clientSecret` from `POST /api/orders`. Ops: Sentry, a synthetic canary order every 5 minutes against a canary location, and a launch runbook.

**Tech Stack:** unchanged from Plan 1 (Next 16 App Router, Drizzle/Neon, Inngest, Stripe, Vitest) + `@stripe/stripe-js` + `@stripe/react-stripe-js` + `@sentry/nextjs`.

## Global Constraints

Everything in Plan 1's Global Constraints still binds (money = integer cents; RLS + scoped repos; snapshots pinned; append-only events; webhook idempotency; direct charges only, Payment Element only, SAQ A; 5s polling; TDD; the docs/superpowers/plans/2026-09-20-ordering-spine-followups.md launch gates). New, Plan-2-specific:

- **Browse reads snapshots, never live menu tables.** The storefront's data source is the latest `menu_snapshots.payload` for the location. If browse and `createOrder` ever disagree, the customer sees a rejection createOrder already produces (86'd, price change) — that is the designed behavior, not a bug to paper over.
- **The cart never computes money the server doesn't recompute.** Client-side totals are display-only; the authoritative total comes back from `POST /api/orders`.
- **TCPA consent is captured at checkout day one** (spec §6): a SEPARATE, UNCHECKED SMS-marketing opt-in checkbox with the required disclosure text. Customers-table lands in Plan 3; until then consent lives on the ORDER row (`smsMarketingConsent boolean not null default false`, `consentAt timestamptz nullable` — migration in Task 4) and Plan 3 migrates it. Transactional SMS needs no consent and is unaffected.
- **Pickup only** (spec v1). Delivery UI must not exist, not be "hidden."
- **Customer-facing times render in the LOCATION's timezone** (the `renderTicket` rule, now binding on web).
- **Phone-first**: every storefront screen is designed at 390px first; food photography above the fold on the menu (restaurant-playbook rule — the measurable thing we beat incumbents on).
- **No customer accounts, no saved cards** (v1 scope). Guest checkout: name + phone (+ optional email).
- **Data accuracy** (house rule): Kashi's 92 items come from their published menu/ordering data verbatim; nothing invented. Unsourced modifier structure must be flagged `NEEDS_KASHI_CONFIRMATION` in the seed, greppable.
- **The storefront and the feed must not regress each other**: full suite green after every task; the spine's 462 tests are the floor.
- **Public routing key is `locations.storefront_slug`, platform-unique** (ruling added 2026-09-22 after Task 1: the org-scoped `locations.slug` is ambiguous across tenants on a public route, and Kashi's location slug is `livingston` while the customer URL must read `kashi`). `slug` stays the org-scoped internal key used by the authed feed/86/pause routes; `storefront_slug` is what `/order/[slug]` and the storefront API resolve. Multi-location reads `kashi-livingston`.
- **The snapshot payload carries everything a dish card renders** — name, description, photoUrl, tags, price, is86d, and modifier groups with effective limits (extended 2026-09-22 after Task 1; browse may not fall back to live tables to fill gaps).

## External accounts (Rohan's side — from the followups doc, restated)

Tasks note which they need. Vercel project (Task 10) is the only new one; Stripe/Twilio/Inngest/Clerk gates are unchanged from the followups doc.

## File Structure

```
src/
  app/
    order/[location]/
      page.tsx              # menu browse (server component from snapshot)
      cart-provider.tsx     # client cart context
      dish/[itemId]/        # (modal-in-page; no separate route — see Task 2)
      checkout/page.tsx     # contact + tip + consent + Payment Element
      status/[orderId]/page.tsx  # confirmation + live status
    api/
      storefront/[location]/route.ts   # GET snapshot payload + open state
      orders/[id]/status/route.ts      # GET public status by id (scoped token)
  domain/
    storefront.ts           # snapshot → view model, open-state summary
  lib/
    cart.ts                 # cart reducer + display-only totals (pure)
    stripe-browser.ts       # loadStripe memo w/ stripeAccount
  inngest/
    canary.ts               # synthetic order every 5 min
scripts/
  seed-kashi-full.ts        # the 92-item build (extends seed-kashi.ts)
sentry.*.config.ts
```

---

### Task 1: Storefront data endpoint + snapshot view model

**Files:**
- Create: `src/domain/storefront.ts`, `src/app/api/storefront/[location]/route.ts`
- Test: `src/domain/storefront.test.ts`, `src/app/api/storefront.test.ts`

**Interfaces:**
- Produces: `storefrontView(locationId, tx): Promise<StorefrontView>` where `StorefrontView = { location: { name, slug, timezone, phoneE164, address, prepTimeMinutes }, open: { open: boolean; reason? }, snapshotVersion: number, categories: SnapshotCategory[] }` — categories passed through from the latest snapshot payload with 86'd items INCLUDED but marked (the UI greys them; hiding them makes the menu look thinner than the restaurant is). Throws `NoMenuError` when no snapshot exists.
- GET `/api/storefront/[location]` (location = slug, public, no auth): 200 `StorefrontView` | 404 unknown slug. Cache: `s-maxage=30, stale-while-revalidate=300` — browse survives DB blips via CDN staleness.
- Consumes: `menuSnapshots` latest (Task 4 Plan 1), `isOpenAt(locationId, at, tx)`, locations via `db()` (RLS-exempt).

- [ ] **Step 1: Failing tests** — seeded location + snapshot → view carries the snapshot's categories verbatim including an 86'd item's `is86d: true`; open-state present; version matches; no-snapshot location → `NoMenuError`; route: 200 with cache header, 404 for junk slug (no existence oracle text).
- [ ] **Step 2: Implement.** The route resolves slug → location via `db()`, then `withLocation` for the snapshot read.
- [ ] **Step 3: Green; commit** — `feat: storefront view from the pinned snapshot, public menu endpoint`

---

### Task 2: Menu browse page

**Files:**
- Create: `src/app/order/[location]/page.tsx`, `src/app/order/[location]/browse.tsx` (client), `src/app/order/[location]/cart-provider.tsx`
- Test: `src/app/order/browse.test.tsx`

**Interfaces:**
- Server component fetches `storefrontView` directly (no self-HTTP); renders: location header (name, open/closed state with the closed reason in plain words + today's hours), **sticky category chips** (restaurant-playbook: active chip tracks scroll; no 26,000px hunts), dish cards (photo when `photoUrl`, else the typographic plate treatment; name, description, allergen/diet `tags` as pills, price from cents). 86'd: greyed, "sold out today", not addable.
- Dish detail opens IN-PAGE (bottom sheet on mobile): modifier groups from the snapshot with EFFECTIVE limits (`minSelect`/`maxSelect` as pinned — the Task 4 Plan-1 ruling: minSelect decides mandatoriness), qty stepper, notes field (cap 500 to match `assertInputShape`), "Add — $X.XX".
- Produces for Task 3: `cart-provider.tsx` exporting `useCart()` — `{ lines, addLine(line), removeLine(ix), setQty(ix, qty), clear() }` with `CartLine = { menuItemId, name, unitPriceCents, qty, modifierOptionIds, modifierNames, modifierDeltaCents, notes? }`.
- Phone-first: 390px is the design target; food above the fold; `grid-cols-1` explicit.

- [ ] **Step 1: Failing render tests** — categories render in snapshot order; 86'd item greyed and not addable; a modifier group with `minSelect: 1` blocks Add until a selection; price updates with deltas; tags render as pills.
- [ ] **Step 2: Implement** (client `browse.tsx` receives the view as props; cart in React context + `localStorage` persistence keyed by location slug, try/catched).
- [ ] **Step 3: Green; `npm run shoot`-equivalent visual check via dev server at 390px; commit** — `feat: snapshot-rendered menu browse with sticky chips and in-page dish sheet`

---

### Task 3: Cart math + review

**Files:**
- Create: `src/lib/cart.ts`, cart drawer UI in `browse.tsx`
- Test: `src/lib/cart.test.ts`

**Interfaces:**
- Produces: pure `cartTotals(lines, taxRatePer100k): { subtotalCents, taxCents, totalCents }` — **display-only**, computed with the same `roundHalfUp`/`taxCentsFor` helpers as the server (import from `src/lib/money.ts`, no reimplementation), plus `lineTotalCents(line)`.
- Cart drawer: lines with qty steppers, per-line modifiers/notes, subtotal/tax/est. total labeled "estimated — confirmed at payment", Checkout button disabled when closed/paused (from the view's open state) with the reason shown.

- [ ] **Step 1: Failing tests** — totals for the Plan-1 contract cart (2×(1800+200) @ 8875 → 4000/355/4355 pre-tip) via the REAL money helpers; qty 0 removes; line identity includes modifier set (same item, different modifiers = separate lines).
- [ ] **Step 2: Implement; green; commit** — `feat: cart with display-only totals from the shared money helpers`

---

### Task 4: Checkout — contact, tip, consent, and the order POST

**Files:**
- Create: `src/app/order/[location]/checkout/page.tsx` (+ client form), migration for order consent columns
- Modify: `src/app/api/orders/route.ts` (accept + persist consent fields), `src/domain/create-order.ts` (input + insert)
- Test: extend `src/app/api/orders.test.ts`, `src/domain/create-order.test.ts`

**Interfaces:**
- Migration: `orders.sms_marketing_consent boolean NOT NULL DEFAULT false`, `orders.consent_at timestamptz` — schema-declared, no drift.
- `CreateOrderInput` gains `smsMarketingConsent?: boolean` (default false); when true, `consentAt = now`. `assertInputShape`: boolean-or-undefined.
- Checkout form: name (required), phone (required, US-normalized to E.164 client-side, server re-validates shape), email (optional), tip presets 0/10/15/20% + custom cents, pickup time = ASAP with live quote (`prepTimeMinutes` from the view, rendered in the LOCATION's timezone), the consent checkbox — UNCHECKED, its own block, with disclosure: "Yes, text me offers and updates from {restaurant name}. Msg & data rates may apply. Reply STOP to opt out." — and payment mode: Card | Pay at pickup.
- Submit → `POST /api/orders`; card → Task 5 takes the `clientSecret`; pay_on_pickup → straight to status page.

- [ ] **Step 1: Failing tests** — consent columns land on the order row only when the box was checked (both states asserted); unchecked-by-default is a UI render test; tip custom path produces exact cents; `consentAt` null when false.
- [ ] **Step 2: Implement; full suite green (462+ floor); commit** — `feat: guest checkout with TCPA consent capture on the order row`

---

### Task 5: Payment Element (direct charge confirm flow)

**Files:**
- Create: `src/lib/stripe-browser.ts`, payment step UI in checkout
- Modify: `src/app/api/storefront/[location]/route.ts` (expose `stripeAccountId` — it is public-safe: it's in every Stripe.js call already)
- Test: `src/lib/stripe-browser.test.ts` + checkout flow test with mocked stripe-js

**Interfaces:**
- `stripeBrowser(stripeAccountId)`: memoized `loadStripe(NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY, { stripeAccount })` — **the platform publishable key with the connected account option** is the direct-charge browser mechanic; document it where it's written.
- Flow: POST /api/orders (card) → `{ orderId, clientSecret }` → `<Elements options={{ clientSecret }}>` + `<PaymentElement/>` → `stripe.confirmPayment({ redirect: 'if_required', confirmParams: { return_url: /order/[location]/status/[orderId] } })` → success routes to status page; failure shows Stripe's message inline and the order stays PENDING_PAYMENT (retryable — same PI).
- A location with no `stripeAccountId`: card option HIDDEN at checkout (pay-at-pickup only), matching the server's named rejection.
- Env: `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` (blank-safe: card option hidden when absent).

- [ ] **Step 1: Failing tests** — memoization (one loadStripe per account); card option hidden when no account id / no publishable key; confirm-failure keeps the cart intact and surfaces the message.
- [ ] **Step 2: Implement; green; commit** — `feat: Payment Element on the connected account, card-optional checkout`

---

### Task 6: Status page + public status endpoint

**Files:**
- Create: `src/app/order/[location]/status/[orderId]/page.tsx` (+ client poller), `src/app/api/orders/[id]/status/route.ts`
- Test: `src/app/api/order-status.test.ts`

**Interfaces:**
- GET `/api/orders/[id]/status?location=<slug>`: PUBLIC but unguessable (uuid) — returns ONLY `{ shortCode, status, paymentStatus, quotedReadyAt, placedAt }` — no contact data, no line items, no money (an order id leaking must not leak PII). 404 outside the slug's location (predicate + RLS, both — the Task 12 doctrine).
- Status page: huge shortCode ("show this at the counter"), state strip PLACED → ACCEPTED → READY with the quoted time in the location's timezone, 5s polling, PENDING_PAYMENT shows "confirming payment…" (webhook lag), REJECTED/CANCELED shown honestly with the restaurant's phone as the next step.

- [ ] **Step 1: Failing tests** — response shape excludes PII (assert exact key set); cross-location 404; PENDING_PAYMENT rendering.
- [ ] **Step 2: Implement; green; commit** — `feat: public order status by unguessable id, PII-free`

---

### Task 7: Stripe-down fallback + storefront hardening

**Files:**
- Modify: checkout (Task 4/5 files), `src/app/api/orders/route.ts`
- Test: extend orders route tests

**Interfaces:**
- Spec §8: Stripe outage → the location flips to pay-at-pickup rather than refusing orders. Mechanic: PI creation failure (network/5xx from Stripe, NOT card decline) → the route cancels nothing, converts the order to `PAY_ON_PICKUP`/NEW in the same transaction, announces it, and returns `{ paidAtPickup: true }`; checkout shows "card payments are down — pay at pickup" and routes to status. Card DECLINES are not outages: PENDING_PAYMENT + inline retry (Task 5 behavior) stands.
- Cap: per-location unpaid-order guard (spec): max 10 open PAY_ON_PICKUP orders per contact phone per day — reject with a coded error surfaced kindly.

- [ ] **Step 1: Failing tests** — Stripe 5xx → order lands NEW/PAY_ON_PICKUP + fan-out announced + response flags it; card_declined error type → PENDING_PAYMENT retained; the unpaid cap triggers at 11.
- [ ] **Step 2: Implement; green; commit** — `feat: pay-at-pickup failover when Stripe is down, unpaid-order cap`

---

### Task 8: Sentry + the synthetic canary

**Files:**
- Create: `sentry.client.config.ts`, `sentry.server.config.ts`, `src/inngest/canary.ts`; `scripts/seed-canary.ts`
- Test: `src/inngest/canary.test.ts`

**Interfaces:**
- Sentry via `@sentry/nextjs` wizardless manual setup (env `SENTRY_DSN`, blank-safe no-op locally); errors in routes/Inngest get captured; no PII in events (scrub contact fields).
- Canary: Inngest cron `*/5 * * * *` → place a pay_on_pickup order at the CANARY location (seeded by `seed-canary.ts`: org `serveside-canary`, hidden from everything human-facing, always-open hours, one $0.01 item — 1 cent keeps money-paths real) via `createOrder` directly → wait → assert a `print_jobs` row exists → mark the canary run row; two consecutive failures → SMS `OPS_ALERT_E164` (reuse the 1/hour cooldown pattern). Canary orders auto-CANCELED after assertion so the table doesn't fill with NEW.
- The canary must not fire alerts for the canary location's "printer offline" (it has no printer row — heartbeat skips locations without printers already; verify, don't assume).

- [ ] **Step 1: Failing tests** — canary success path leaves a confirmed run + canceled order; failure path (no print job) alerts once with cooldown; heartbeat ignores the canary location.
- [ ] **Step 2: Implement; green; commit** — `feat: Sentry + a 1-cent synthetic order every 5 minutes`

---

### Task 9: The full Kashi menu (92 items)

**Files:**
- Create: `scripts/seed-kashi-full.ts` (+ a `data/kashi-menu.ts` data module)
- Test: `scripts/seed-kashi-full.test.ts`

**Interfaces:**
- Source of truth, in order: Kashi's own site menu (descriptions/allergens live in `/Users/rohan/Projects/AgenticAgency/client-sites/src/clients/kashi/config.ts` — the demo's researched data, READ-ONLY) + their live ordering page prices. Where the two disagree, the main site wins and the conflict is listed in the script's output (roster rule).
- Every item: name, description, price (verbatim), tags. Photos: `photoUrl` only where a real photo exists in the demo's assets (the 20 photoless dishes stay photoless — the typographic plate is the design, and the gap is the SALES story).
- Modifier groups: ONLY structures Kashi's data supports; anything inferred carries `NEEDS_KASHI_CONFIRMATION` in a comment AND a `--strict` flag that excludes unconfirmed groups (launch runs `--strict` until Kashi signs off).
- Idempotent re-runs (upsert by name within category); final act rebuilds the snapshot (the Plan-1 ruling); prints a summary: items, categories, photos present/missing, unconfirmed groups.

- [ ] **Step 1: Build the data module from the sources; failing test** — 92 items land, categories match Kashi's site sections, at least the ten Plan-1 dishes byte-identical to before (regression), snapshot rebuilt, `--strict` excludes flagged groups.
- [ ] **Step 2: Implement; run against dev; green; commit** — `feat: the full 92-item Kashi menu, strict-mode gated on their confirmation`

---

### Task 10: Vercel deploy + production wiring

**Files:**
- Create: `docs/runbooks/deploy.md`; `vercel.json` only if needed
- Modify: `.env.example` (complete prod var list, grouped by service)

**Interfaces:**
- Own Vercel project `serveside` (NEVER inside client-sites — spec boundary), importing github.com/RohanSRamnani/serveside, main = production. Env per the followups doc's launch gates. Neon prod branch created + migrated + `db:app-user` (the runbook scripts each step; the boot guard enforces the role).
- Inngest cloud app registered against the deployed `/api/inngest`; Stripe CONNECT webhook pointed at the deployed `/api/stripe/webhook`; Clerk production instance.
- **This task is checklist + runbook + the parts doable from CLI (vercel project can be created/linked via `npx vercel link/deploy` if authed); every step needing Rohan's dashboards is written as HIS checklist item, not skipped silently.** The task is DONE when a preview deployment serves `/order/kashi` (Kashi's `storefront_slug`, per Global Constraints) from the prod-candidate database and the runbook's remaining items are explicitly listed.

- [ ] **Step 1: Write the runbook from the followups doc; execute the CLI-able parts; verify the preview deployment end-to-end (browse renders, status page loads).**
- [ ] **Step 2: Commit** — `feat: deploy runbook + Vercel project, preview serving the storefront`

---

### Task 11: End-to-end walkthrough + launch runbook

**Files:**
- Create: `scripts/e2e-card-walkthrough.md` (manual script), `docs/runbooks/kashi-launch.md`
- Test: one automated e2e (vitest, test-mode Stripe mocked at the boundary as in Plan 1) covering browse-view → cart math → POST → webhook flip → fan-out → status transition — the whole seam chain in one test.

**Interfaces:**
- The launch runbook (spec stage 7): parallel-run week (Serveside live alongside the incumbent), the Google Business "Order Online" link flip (needs Kashi's GBP access — Rohan gate), rollback (point the link back), the first-week checks (canary green, alarms armed, printer confirmed on real hardware incl. the `×` glyph).

- [ ] **Step 1: The seam e2e (RED on any missing wiring), then green.**
- [ ] **Step 2: Write both runbooks; full suite; commit** — `feat: seam e2e + the Kashi launch runbook`

---

## Self-review notes (done at write time)

- **Spec coverage, stages 4–7**: browse/cart/checkout/confirmation (T1–6), scheduled orders excluded (spec: deliberately out), ops canary + Sentry + printer heartbeat already live (T8 + Plan 1), Kashi menu (T9), soft-launch + link flip (T11). Dashboard polish (spec stage 8) and marketing (stage 9) are Plan 3.
- **Consent-on-order deviation** from the spec's customers-table placement: deliberate, documented in Global Constraints, migrates in Plan 3.
- **Type consistency**: `StorefrontView` produced T1, consumed T2/T5; `useCart` produced T2, consumed T3/T4; money helpers imported from Plan 1's `src/lib/money.ts` everywhere — no reimplementation anywhere.
- Deferred deliberately: order.kashiny.com custom-domain mapping (ships with the link flip — one row in a host map, pattern proven in client-sites); the constraint/index wave and CLAUDE.md prune ride as the followups doc says, not inside this plan.
