# Restaurant Ordering Backend + AI Phone Agent — Design

Date: 2026-09-07
Status: awaiting Rohan's review

## Goal

Build the product layer under the client-site factory: a multi-tenant backend
that takes real restaurant orders (web first, phone second), routes them to a
kitchen tablet + printer + SMS, settles payment with the restaurant as merchant
of record, and gives the owner a dashboard worth paying for every month.

The competitor is The Fast Bite: ~75 live tenants against 613 dead subdomains
(~89% attrition) on a 2013 jQuery/PHP stack. Their churn is the thesis. A
restaurant churns when nothing lands in their hands between invoices. Every
design decision below is scored against "does the owner see value this week."

## Decisions (settled in discovery)

- **No POS integration in v1.** Orders route to tablet + cloud printer + SMS.
  A `PosAdapter` interface ships with a null implementation; Square is adapter
  #1 if a client demands it.
- **Stripe Connect, Standard accounts, direct charges.** The restaurant is
  merchant of record. Funds never touch our platform balance. 0% commission —
  we bill SaaS separately.
- **Web ordering and voice are separate products with different cost
  structures.** Ordering costs us ~$20–25/mo per client. Voice costs 10–20×
  that. Never bundle them into one flat price.
- **Two design partners, not one.** Kashi (Brooklyn Indian, 92 items, low
  volume) proves the ordering spine. Voice needs a second, busier restaurant.
- **Delivery shape defaults to an ordering subdomain** (`order.kashiny.com`).
  Same page we'd build anyway, total control, their site untouched. Full site
  rebuild is included free (it's already built as the sales demo). True
  embedding into their CMS is the rare, surcharged exception.
- **Kashi pilot terms:** free setup, $99/mo, minutes-capped voice experiment
  later. In exchange, in writing: named case study, 60-second owner video,
  three intros. Not free food.

## Pricing

| Tier | Setup | Monthly |
|---|---|---|
| Site only (bridge product) | $1,500 | $99 |
| Site + ordering | $2,500 | $299 |
| Voice agent | $500 | $199, 500 min included, $0.29/min after |
| Additional location | — | $99 |

Setup is never waived. Annual prepay gets two months free.

Kashi is a deliberate exception to this rate card — founding-client terms,
priced above. Nothing about the pilot's pricing should anchor client #2. Note
that $99/mo is FastBite's price point, i.e. the tier with 89% churn.

Setup is framed as **"Menu Build & Launch"** — the 92-item menu digitization is
the real labor and it's identical whichever storefront shape they choose. The
website is a delivery detail, included by default. The **ordering subdomain**
(`order.theirsite.com`) is the default delivery shape and costs us nothing
extra; a true CMS embed is a support surface we don't control and is quoted
case by case.

**Voice is never sold flat-unlimited.** At ~$0.10–0.15/min all-in and a ~2.5min
blended call, a restaurant taking 50 calls/day costs ~$450/mo to serve. Flat
$199 would be a 171% loss. Flat + included minutes + overage is the same
economics in a bill an owner will sign.

---

## 1. Architecture

### Repository and deploy boundary

A **separate Next.js app**, `agentcy-orders`, in its own Vercel project — not
inside `client-sites`. The client-site factory ships constantly and a bad
config deploy must never take ordering down. The factory links out to the
ordering app; it does not contain it.

### Stack

| Concern | Choice | Why |
|---|---|---|
| App | Next.js 16 on Vercel | Same as the factory, one thing to know |
| DB | Neon Postgres + Drizzle | Cheap, branchable, boring |
| Tenancy | Scoped repository layer + Postgres RLS | Belt and braces; one missing WHERE clause leaks another restaurant's orders |
| Auth | Clerk Organizations | Maps 1:1 onto org/location; saves a week |
| Background work | Inngest | Durable retries are the ops property we need |
| Order feed realtime | **5s polling, not WebSockets** | Boring on purpose. Debuggable at 7pm. |
| Voice media layer | Vapi (or Retell) | Turn-taking and barge-in are not our differentiator |
| Telephony numbers | Twilio | Provider-level failover routing |
| SMS | Twilio | |
| Email | Resend | Already used by lead-stack |
| Photos | Vercel Blob | |
| Printer | Star CloudPRNT (mC-Print3) | Pull-based — no inbound firewall, survives tablet death |
| Monitoring | Sentry + Betterstack | On-call for one person |

### The order path is deliberately dumb

Order submission is a small, isolated write path with no dependency on the
dashboard app, the menu editor, or anything else. If every other surface is
broken, orders still land. This is the single most important structural
decision in the system.

**Every order fans out three ways at creation:** DB row, printer job, SMS to
the owner. Two of three can fail and a human still gets the order.

---

## 2. Data model

Postgres. All money is `bigint` cents — never floats. Every table carries
`org_id` or `location_id`.

### Tenancy

```
organizations      id, name, slug, created_at
locations          id, org_id, name, address, lat, lng, timezone,
                   phone_e164, prep_time_minutes, tax_rate_per_100k,
                   pickup_enabled, delivery_enabled,
                   stripe_account_id, printer_id, status
users              (Clerk-backed) id, email, name
memberships        user_id, org_id, location_id nullable, role
                   (owner | manager | staff)
```

Menus, hours and orders are scoped to **location**, not org. Multi-location is
in the pricing from day one, and retrofitting location scoping is brutal.

### Menu

```
menus                  id, location_id, name, is_active
menu_categories        id, menu_id, name, sort, availability_window_id
menu_items             id, category_id, name, description, base_price_cents,
                       photo_url, sort, is_active, tax_category, tags[],
                       is_86d, unsnooze_at
modifier_groups        id, location_id, name, min_select, max_select, required
modifier_options       id, group_id, name, price_delta_cents, is_active,
                       is_86d, unsnooze_at
item_modifier_groups   item_id, group_id, sort, min_override, max_override
availability_windows   id, location_id, dow, start_time, end_time
```

Modifier groups are **location-scoped and reusable** across items — a "Spice
Level" group is defined once and attached to forty dishes.

**86'ing works on modifier options too**, not just items. Running out of a
topping is as common as running out of a dish, and every competitor gets this
wrong.

`unsnooze_at` gives "86 until tomorrow," which is what owners actually want.
A nightly job clears expired flags at open. This prevents the classic failure
where an item stays 86'd for three weeks because nobody remembered.

### Menu snapshots — the load-bearing table

```
menu_snapshots     id, location_id, version, payload jsonb, created_at
```

Immutable. Written whenever the menu changes. **Every order and every voice
call references a `snapshot_id`.** This is how you win a price dispute, how the
voice agent gets a consistent view for the length of a call, and how you prove
what was quoted six months later.

### Hours and pauses

```
business_hours     location_id, dow, open_time, close_time
holiday_closures   location_id, starts_at, ends_at, reason
order_pauses       location_id, until, reason, created_by
```

`business_hours` supports **multiple ranges per day** — split hours (lunch
close 3–5pm) are the norm, not the exception.

`order_pauses` is the "we're slammed, stop taking orders" button. Essential,
always forgotten, and the thing that saves you the first time a location gets
buried.

### Orders

```
orders              id, location_id, short_code, channel (web|voice|sms),
                    fulfillment (pickup|delivery), status, payment_status,
                    customer_id nullable, contact_name, contact_phone,
                    contact_email, scheduled_for, quoted_ready_at,
                    subtotal_cents, tax_cents, tip_cents, delivery_fee_cents,
                    discount_cents, total_cents,
                    stripe_payment_intent_id, menu_snapshot_id, notes,
                    created_at, accepted_at, ready_at, completed_at,
                    canceled_at, cancel_reason
order_items         id, order_id, menu_item_id, name_snapshot, qty,
                    unit_price_cents, line_total_cents, notes
order_item_modifiers order_item_id, modifier_option_id, name_snapshot,
                    price_delta_cents
order_events        id, order_id, type, actor, payload jsonb, at
```

**Names and prices are snapshotted onto the order rows.** Never join a
six-month-old order to a live menu item. Non-negotiable.

`order_events` is append-only. Debugging a disputed order at 7pm on a Friday
depends entirely on this table existing from day one.

Status machine:

```
PENDING_PAYMENT → NEW → ACCEPTED → IN_KITCHEN → READY → COMPLETED
                   ↓        ↓
                REJECTED  CANCELED
```

Voice orders paying at pickup enter at `NEW` with
`payment_status = PAY_ON_PICKUP`.

### Customers

```
customers          id, org_id, phone_e164, email, name, first_seen, last_seen,
                   order_count, lifetime_value_cents,
                   sms_marketing_consent, email_marketing_consent,
                   consent_source, consent_at
customer_addresses id, customer_id, line1, line2, city, state, zip, lat, lng
```

Customers belong to the **org**, not us. That's the pitch against DoorDash and
it needs to be true in the schema.

The consent fields are load-bearing for TCPA and must be captured at checkout
by a **separate, unchecked** opt-in box. If it's not in the checkout UI on day
one you can never legally market to the list you spent a year building.

**We store no cards.** Saved payment methods are Stripe Customers created *on
the connected account* — which means a saved card is scoped to one restaurant
and does not follow the diner to another client of ours. That's legally correct
and worth stating plainly so nobody designs against it.

### Voice

```
phone_numbers  id, location_id, e164, provider,
               mode (overflow | full_forward | ported), forward_to_e164
calls          id, location_id, from_e164, to_e164, started_at, ended_at,
               duration_seconds, outcome, transferred_to, recording_url,
               cost_cents, order_id nullable, menu_snapshot_id
call_turns     id, call_id, role, text, at, latency_ms
agent_configs  location_id, greeting, voice_id, persona,
               escalation_rules jsonb, max_call_seconds, allow_pay_at_pickup
```

`outcome` ∈ `order_placed | info_answered | transferred | voicemail |
abandoned | spam`.

`call_turns.latency_ms` exists because you cannot tune a voice agent you can't
measure, and "it felt slow" is not a bug report.

### Marketing and platform

```
campaigns       id, org_id, channel, segment_definition jsonb, template,
                scheduled_at, status
messages        id, org_id, customer_id, campaign_id nullable, channel,
                provider_ref, status, sent_at
suppressions    org_id, channel, address, reason, created_at
printers        id, location_id, provider, serial, last_seen_at
webhook_events  provider, external_id UNIQUE, payload, processed_at
```

`webhook_events.external_id UNIQUE` is the idempotency guard for Stripe and
Twilio. Stripe *will* deliver the same event twice.

`printers.last_seen_at` drives the "your printer is offline" alert — sent to
the restaurant, not just to us.

`suppressions` must be instant on STOP. This is a legal requirement, not a
feature.

---

## 3. Payments

**Stripe Connect, Standard accounts, direct charges.** The charge is created on
the connected account via the `Stripe-Account` header. The restaurant is
merchant of record, their descriptor is on the statement, funds settle to them,
and they carry refund and chargeback liability.

Never use separate charges + transfers, and never destination charges. Both
route money through our balance and undo the entire premise.

**PCI scope:** Payment Element only. Card data never reaches our servers →
SAQ A. Anything that types a raw PAN into our system drops us to SAQ A-EP or
worse. This is the whole reason phone orders pay by SMS link.

**What we own regardless of liability:**

- Blame. They carry chargebacks; they will still call us. The **dispute
  evidence packet** (order detail, call transcript, pickup timestamp, snapshot
  version) ships as a one-click export. It is a genuine feature, not overhead.
- Refunds and comps from inside the order feed. If it isn't there, the owner
  refunds in Stripe directly and our order state goes stale.
- Sales tax. We compute it. v1 is a per-location rate the owner attests to in
  the contract. Revisit at ~20 clients or the first multi-state cluster.
- Stripe KYC onboarding — EIN, bank, owner SSN. Cash-heavy independents stall
  here and deals die on paperwork. Start it at contract signature.

**Stripe outage fallback:** the location flips to pay-at-pickup automatically
rather than refusing orders.

---

## 4. Restaurant dashboard

This is what justifies the monthly fee. Designed for a greasy thumb on a cheap
Android tablet in a loud kitchen.

**Live order feed (home screen).** Large cards. Audible, repeating alert until
acknowledged. One-tap Accept with a prep-time bump (+5/+10/+15). Ready.
Complete. No small buttons anywhere.

**The 86 button — two taps from the feed.** Search item → toggle → "until
tomorrow / until I turn it back on." This is the highest-frequency action in
the entire product and its speed determines whether the dashboard gets opened
daily or never.

**Pause ordering.** "We're slammed" with auto-resume.

**Today strip.** Orders, dollars, average ticket, calls answered. This is the
number the owner screenshots and sends to their spouse. The dashboard must show
them money they would not otherwise have had — that is the entire retention
mechanic.

**Menu editor with a completeness score.** Kashi has 92 items: 37 with no
photo, 2 with a description. A nag that says *"12 items have no photo — items
with photos sell measurably better"* is useful, is true, and is a natural
upsell surface. Steal the idea directly from the competitor's failure.

**Hours + holiday closures.**

**Call log** with transcripts and recordings, filterable to escalated and
failed. The owner listening to their own AI in week one is what builds trust —
and it surfaces our bugs faster than any monitoring.

**Customers** list with one button: "text everyone who hasn't ordered in 60
days."

**Monthly report**, auto-emailed. This is the invoice justification.

### Menu maintenance is a service, not a feature

For the first cohort, **we edit the menu for them.** Email us a photo, we
update it. FastBite's sites rot because the restaurant never opens the CMS.
Doing it for them is cheap with AI leverage, keeps menu quality high, and is a
retention mechanic disguised as support.

---

## 5. Customer ordering flow

Menu browse → item detail with modifier groups → cart → checkout.

- **Guest checkout by default.** Phone + name is the whole identity. Accounts
  are optional and come later.
- **Pickup only in v1.** Delivery is a separate product with its own liability.
- Modifier groups enforce min/max at the UI and again server-side.
- Checkout: contact, pickup time (ASAP with live quote, or scheduled), tip
  presets, Payment Element, and the **separate unchecked SMS marketing opt-in**.
- Order confirmation page with live status + SMS updates at Accepted and Ready.
- One-tap reorder from a phone-number lookup — no password.

The menu browse page is served statically from the edge with a snapshot, so
**browsing works even when the database is down.** Only submission needs the
write path.

---

## 6. Marketing layer

The restaurant owns the list. That's the story. It's also the biggest legal
exposure in this document.

- **Transactional SMS** (receipts, status, payment links): fine, no separate
  consent.
- **Marketing SMS:** requires express written consent captured at checkout with
  the required disclosure language. Statutory damages are $500–1,500 *per
  message*. Get this right on day one or don't build it.
- **A2P 10DLC registration is per-brand, takes 1–3 weeks, and gates all SMS
  including the payment link.** Start it at contract signature, not at launch.
  This will delay every single onboarding and nobody plans for it.
- **Email first for campaigns** — CAN-SPAM is far more forgiving than TCPA.

**v1 marketing is four things and nothing else:** transactional messages,
consent capture, one automated win-back at 45 days, one abandoned cart at 1
hour. No campaign builder. No segment editor.

Be honest internally about the timeline: at 200 customers a restaurant's list
is worth little. The value shows at twelve months. So the *first* marketing win
has to be immediate — the win-back, and the "we're open Thanksgiving" blast.

---

## 7. AI phone ordering agent

### Telephony: sell overflow first, never lead with a port

Three modes, in order of how safe they are to sell:

1. **Overflow** — their number stays theirs; conditional call forwarding
   (busy / no-answer) sends unanswered calls to us. Enabled by the owner with
   a carrier star code, reversible in ten seconds. If our stack dies, calls
   simply ring the restaurant like they always did. **This is the default.**
2. **Full forward** — we provision a new number, they forward everything to it,
   we transfer back on escalation. Full-line answering with no port.
3. **Port** — only for a client who insists, and never early. A botched port
   takes their phone down for days. That is existential for them and
   unrecoverable for us.

### Latency budget

People tolerate roughly 500–800ms of silence on a phone call. Past ~1.2s they
say "hello?" or talk over the agent. Target **p50 ≤600ms, p95 <1.2s** to first
audio.

| Stage | Budget |
|---|---|
| VAD / endpointing | 150–250ms ← the big tunable |
| Streaming STT finalize | 50–100ms |
| LLM time-to-first-token | 200–400ms |
| TTS time-to-first-byte | 100–200ms |
| Telephony + network | 50–100ms |
| **Total** | **~600–1,000ms** |

Cascaded (STT → LLM → TTS) over speech-to-speech, because we need **strict
tool-calling discipline against a fixed menu** more than we need the last
200ms of naturalness. Speech-to-speech is faster and warmer but much harder to
constrain to real item IDs, and hallucinating a menu item is the failure that
kills the product.

### Menu grounding — the anti-hallucination design

**The agent cannot type an item name into an order. Ever.** The only path to
adding an item is a tool call:

```
add_item(item_id, qty, modifier_option_ids[], notes)
```

Validation lives in the **tool layer, not the prompt**. An `item_id` outside
the call's snapshot is rejected by our code and the model gets an error it must
recover from by asking again. Prompts are guidance; code is the guarantee.

- The menu snapshot is loaded at call start and pinned for the call's duration.
  Kashi's 92 items is ~3–5k tokens — cacheable, cheap.
- `search_menu(query)` gives fuzzy resolution ("chicken tikka" → three real
  candidates) so the model matches against data rather than inventing.
- **86'd items are checked twice:** in the snapshot at call start, and live
  inside `add_item`, so an item 86'd mid-call fails at add time. The agent
  apologizes and offers the item's configured substitutions.
- Modifier groups return their requirements to the agent — "this item needs a
  protein choice" — so the agent asks rather than guessing.
- Free-text substitutions go into `notes`, flagged for the kitchen, and are
  **never priced by the agent**.
- Prep time comes from location config plus a dashboard override (rush mode:
  20 → 45 min). The agent quotes that number.
- **The agent always reads the full order back with the total before ending.**

### Payment: SMS link, confirmed

Never take a card by voice. A spoken PAN passes through telephony, STT, our
logs, and a model provider — that is SAQ D scope and disqualifying at our size.

Flow: agent confirms order → we send a Stripe payment link by SMS to the
caller's number → they pay on their phone → the webhook flips the order to
PAID and it enters the feed.

**Pay-at-pickup is a required fallback, not an edge case.** Landlines can't
receive SMS at all (detect via carrier lookup and fall back automatically), and
a real share of phone-order customers won't tap a link. Losing them silently is
worse than the no-show risk. Cap unpaid orders per location and per first-time
caller.

### Escalation

Triggers: the caller asks for a human; two consecutive comprehension failures;
profanity or sentiment spike; an unsupported language; **any allergy mention**;
complaints or refunds; reservations if unsupported; any unrecoverable tool
error.

Mechanism: warm transfer to the restaurant's line. If nobody picks up — likely,
since that's why we're on overflow — take a structured callback (name, number,
reason), drop it in the dashboard as a task, and SMS the owner.

**Allergies get their own rule: the agent never asserts that anything is
allergen-free.** Any allergy mention attaches a note to the order and escalates
or explicitly disclaims. This is a lawsuit vector, not a UX preference.

Hostile or unintelligible callers: three strikes → apologize, offer transfer,
end politely, log it. A hard **8-minute call cap** and per-number rate limiting
stop a drunk caller from burning twenty dollars of API spend.

### Unit economics

~$0.10–0.15/min all-in. Order calls run 3–5 min; info calls 45–90s; blended
~2.5 min ≈ **$0.30/call**.

Against a hypothetical flat $199 with no cap:

| Calls/day | Monthly cost | Margin on flat $199 |
|---|---|---|
| 8 | $72 | 64% |
| 25 | $225 | **−13%** |
| 60 | $540 | **−171%** |

Hence **$199/mo including 500 minutes, $0.29/min after** — 500 minutes is
roughly 200 calls and costs us ~$60–75, so the base tier runs ~65% margin and
overage ~59%. The economics break only on *flat-unlimited*, never on metered.
**Never sell flat-unlimited.**

And not every call is an order — "what time do you close," "is my order ready,"
vendors, and robocalls all burn minutes. Answering-machine detection and a
cheap early exit are required, not polish.

### Monthly report

Calls answered, calls answered outside business hours, orders captured, dollars
captured, average order value vs. walk-in, calls escalated, and — the one that
renews the contract — **calls missed before we existed.**

That last number only exists if you measure it. So the install begins with a
**two-week listen-only baseline**: the agent answers the overflow line, takes a
message, and does nothing else. That produces *"you missed 61 calls in 14 days,
23 of them between 6 and 8pm"* — which is both the case study and the price
justification. It is a product requirement, not a report feature.

### Legal

- **Recording consent:** NY is one-party, but multi-state clients mean
  two-party states (CA, FL, PA, IL, MD, MA, WA). Don't build a state matrix —
  **disclose on every call, always.** One line satisfies one-party everywhere
  and establishes implied consent by continuation in all-party states.
- **AI disclosure:** a growing state patchwork. Restaurants aren't a high-risk
  category, but disclosure is free. Say it in the same breath:

  > "Hi, thanks for calling Kashi — you're speaking with an automated
  > assistant, and this call may be recorded."

- **No voiceprints, ever.** Illinois BIPA covers voice biometrics. We identify
  callers by caller ID, never by voice.
- **Recording retention: 30–90 days, then hard delete.**

---

## 8. Operational reality

You cannot buy 99.9% with two people. Design so that **being down does not stop
orders.**

### Layered fallbacks

1. Menu browse is a static edge snapshot — browsing survives a database outage.
2. Order submission is an isolated write path with no dashboard dependency.
3. Every order fans out three ways: DB, printer, SMS to the owner.
4. A failed DB write enqueues durably and reconciles. **Losing a paid order is
   the one unforgivable failure.**
5. Voice stack down → the number's provider-level failover routes straight to
   the restaurant's real line. This is why overflow mode is so much safer.
6. Stripe down → the location flips to pay-at-pickup.

### Monitoring

- **A synthetic order every 5 minutes** against a canary location, end to end:
  place → webhook → printer job queued. This catches more real breakage than
  every metric combined.
- Printer heartbeat — CloudPRNT polls every ~10s; alert at 3 minutes of
  silence, **and tell the restaurant, not just us.**
- Alert on: an order sitting in `NEW` >6 minutes unacknowledged during open
  hours (page the *restaurant* by SMS first, then us), payment webhook lag,
  voice error rate, p95 latency.

### On-call for one person

- **Hours-aware paging.** Nobody gets woken at 3am for a restaurant that closed
  at 10pm. Page only inside some client's open hours.
- **No deploys Thursday 4pm through Sunday midnight.** Feature-flag per
  location. Canary to one location before all.
- A status page, and a per-client degraded banner.

### The real job

Your most common incident will not be an outage. It will be a tablet in a
dead-WiFi corner with the volume down that someone put to sleep. Ship the
tablet in kiosk mode with sleep disabled and your support number printed on the
printer. Budget for this — it is the actual work.

---

## 9. v1 scope

The smallest thing that takes a real paid order at Kashi.

**In:**

- Postgres + tenancy + menu / modifiers / hours / 86 / snapshots
- Order model, status machine, order feed PWA
- Stripe Connect Standard, direct charges, Payment Element
- Star CloudPRNT printer + owner SMS backstop
- Web ordering: browse, cart, guest checkout, pickup only
- Dashboard: feed, 86, pause, hours, menu editor
- Menu entered by us, not them

**Deliberately out:**

- Voice agent (phase 2, and with a *different* design partner)
- Delivery of any kind
- POS integration
- Customer accounts, saved cards, order history
- Marketing campaigns — transactional + consent capture only
- Multi-location switching UI (schema supports it, UI doesn't)
- Self-serve menu editing (we do it for them — a feature, not a gap)
- Scheduled orders
- Number porting

---

## 10. Build sequence

| # | Stage | Effort |
|---|---|---|
| 0 | Kashi agreement; Stripe Connect onboarding; 10DLC registration filed; confirm who controls their DNS and their Google "Order Online" link | Week 0, **blocking — external lead time** |
| 1 | Data layer, tenancy, menu model, internal admin CRUD | 1.5 wk |
| 2 | Order model, status machine, Stripe direct charges, webhook idempotency | 1 wk |
| 3 | Order feed PWA, printer, SMS fan-out, alerting | 1 wk |
| 4 | Customer ordering: browse, cart, checkout, confirmation | 1.5 wk |
| 5 | Ops: synthetic canary, printer heartbeat, paging, failover | 0.5 wk |
| 6 | Kashi menu build — 92 items, photos, write 90 missing descriptions | 1 wk |
| 7 | Soft launch, parallel run, flip the Google link | 1 wk |
| 8 | Dashboard polish: 86 UX, completeness score, monthly report | 1 wk |
| 9 | Marketing: consent capture, win-back, abandoned cart | 1 wk |
| 10 | **Voice** — Vapi, menu tools, read-back, pay link, transfer | 2 wk |
| 11 | Voice pilot: 2-week listen-only baseline, then live | 2 wk calendar |

~11 weeks of build; ~14 weeks calendar to a second paying client.

Stage 0 is genuinely blocking and is the one people skip. 10DLC alone is 1–3
weeks and gates every SMS in the product.

---

## 11. What will bite us

1. **A2P 10DLC lead time** — 1–3 weeks per brand, gates all SMS including
   payment links. File at contract signature.
2. **Sales tax.** We compute a tax the restaurant is liable for. Wrong across
   states is their audit and our fault.
3. **Menu drift.** Their POS menu and ours diverge by week three; the price at
   pickup doesn't match what was paid; the owner blames us. Mitigate with a
   monthly diff prompt and snapshot receipts.
4. **The tablet.** WiFi, sleep mode, volume, YouTube. Your #1 support ticket
   forever. Kiosk-lock it.
5. **Phone carrier logins.** Overflow forwarding needs their carrier's star
   codes and half of them don't know their account. Budget an hour on hold with
   Spectrum per install.
6. **Unacknowledged orders.** The failure isn't taking the order, it's the
   order sitting untouched for 20 minutes on a Friday. Escalating alerts, then
   auto-SMS the owner, then tell the customer to call.
7. **Refunds and comps.** If they're not in the dashboard the owner does them
   in Stripe and our state goes stale.
8. **Chargebacks.** Their liability, our phone call. One-click evidence packet.
9. **Accents and kitchen noise.** An Indian restaurant in Brooklyn is not the
   STT training distribution. Test with real accented audio *before selling
   voice*. This is where voice agents actually die.
10. **Non-English callers.** Decide deliberately: support Spanish, or escalate
    immediately. Don't let it be an accident.
11. **Incumbent ordering contracts.** Prospects are locked into ChowNow / Slice
    / BeyondMenu. Your sales cycle is gated by their renewal date. Ask on call
    one.
12. **The Google Business Profile "Order Online" link.** Whoever owns it owns
    the traffic; Grubhub and DoorDash inject themselves there. Fixing it is a
    10-minute week-one win. Skipping it means your ordering page gets no
    traffic and the pilot looks like a failure that isn't yours.
13. **SLA.** Put a modest one in the contract (99.5%, credits capped at one
    month) before a client writes their own.
14. **E&O / tech liability insurance** (~$1–2k/yr) before client #3.
15. **Setup fee cash flow.** $1,000 barely covers onboarding for clients 1–5.
    Hardware alone is ~$450. Decide explicitly whether it's included or billed.
16. **Concentration risk.** Your first client is 100% of revenue and 100% of
    on-call. Don't sign a second until the first has been quiet for three
    weeks.

---

## Implementation planning

This design is too large for a single implementation plan. Plans are written
per stage group, against the build sequence above:

- **Plan 1 — the spine.** Stages 1–3: data layer, tenancy, menu model, order
  model, Stripe, order feed, printer, SMS fan-out. Ends when a hand-crafted
  order can be paid for and prints in a kitchen.
- **Plan 2 — the storefront.** Stages 4–7: customer ordering UI, ops
  instrumentation, Kashi menu build, launch.
- **Plan 3 — retention.** Stages 8–9: dashboard polish, monthly report,
  marketing.
- **Plan 4 — voice.** Stages 10–11, gated on a second design partner.

Each gets its own plan → implementation cycle. Do not plan past Plan 1 until
Plan 1 ships; the ordering pilot will change assumptions in the later ones.

## Follow-on work

- `restaurant-playbook` skill currently says *"we build the storefront, their
  POS keeps checkout; never imply we take payment."* **This design reverses
  that.** Rewrite the skill when build starts.
- Voice design partner sourcing is its own effort — the criteria are high call
  volume and a phone that goes unanswered at peak, not a bad website.
