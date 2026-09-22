# Spine follow-ups — from the final whole-branch review (2026-09-21)

Plan 1 (the spine) merged with these named obligations. Source: the final
review's triage of the full deferred-minor ledger; the scratch ledger itself
was deleted after merge per process — this file is the surviving record.

## Launch gates (before the first real order)

1. **DB**: Neon prod branch → migrate 0000–0019 as owner → `npm run db:app-user`.
   `DATABASE_URL` must be `app_user` (withLocation hard-refuses a privileged role).
2. **Stripe**: platform account, Connect Standard; webhook registered as a
   **Connect** webhook (else `event.account` is absent and every flip is a
   logged no-op), subscribed to `payment_intent.succeeded`; Kashi's connected
   account KYC done and `locations.stripe_account_id` set (manual SQL — no
   admin path yet).
3. **Twilio**: A2P 10DLC filed (1–3 weeks, gates ALL production SMS);
   `TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM_E164`.
4. **Inngest cloud**: app registered via `/api/inngest`; `INNGEST_EVENT_KEY` +
   `INNGEST_SIGNING_KEY` — all three alarms and the unsnooze cron are dead
   until this exists.
5. **Clerk**: production instance, Organizations enabled; create Kashi's org
   and write `organizations.clerk_org_id` (manual — seed does not set it).
6. `FEED_URL` and `OPS_ALERT_E164` set.
7. **Seed prod**: `npm run seed:kashi` with real hours (never the
   `always-open` dev grid), owner-attested 8.875% tax, kitchen-confirmed
   `prep_time_minutes`.
8. **Printer**: insert the mC-Print3 row (serial = MAC, manual); verify the
   32-col ticket against the real unit — including the `×` glyph on the
   printer's code page.
9. One full card-path walkthrough (`stripe listen`, 4242) before flipping any
   real link. Never `drizzle-kit push` against prod.

## Immediate follow-up waves (post-merge, pre-traffic)

- **Constraint + index wave** (one migration): FK indexes across menu/orders
  chains; `business_hours(location_id, dow)`; a sane-range CHECK on
  `locations.tax_rate_per_100k`; an upper CHECK on order money columns.
- **CLAUDE.md prune** (~40% available): compress webhook/alarms/CloudPRNT rule
  restatements to rule + pointer; fix the "three tables" vs "five exemptions"
  drift in the Two Drivers gotcha.
- **`!= null` for `contact.email` / line `notes`** in `assertInputShape`
  (explicit JSON null currently 422s; `?? null` convention elsewhere).
- Measurement pass on the perf pile: `isOpenAt` round trips, checkout ~8
  in-tx round trips, heartbeat per-poll row update, O(locations) cron scans
  (the second SECURITY DEFINER, argued by name in `rls.test.ts`, is the
  documented fix past low hundreds of locations).

## Plan 2 obligations (recorded in code as TODOs where they bite)

- **Refunds**: rejecting/canceling a PAID order moves no money — dashboard
  refund flow per spec §4; owner refunds in Stripe manually until then.
- **Abandoned-checkout cleanup**: no human path to PENDING_PAYMENT→CANCELED.
- **Menu editor MUST rebuild the snapshot on menu activation/deactivation**,
  plus a reconciliation sweep for stale-skip locations (unsnooze skip path
  logs `[unsnooze] rebuild skipped, snapshot now stale`).
- **Un-announced-NEW sweep**: if Inngest ingest is down at order time, ticket
  + SMS + stale-alarm are all lost together (route logs-and-200s); the feed
  still shows the order. A periodic sweep for NEW orders with no
  `order/created` fan-out closes it.
- Voice/SMS channel callers exercise domain checks the HTTP path shadows
  (non-array modifierOptionIds etc.) — test there when voice lands.
- Webhook: add an `intent.currency` conjunct next time the file is touched;
  page-worthy event for `payment_succeeded_unmatched` on CANCELED orders once
  staff-cancel makes it reachable.
