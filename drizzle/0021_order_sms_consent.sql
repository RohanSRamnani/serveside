-- TCPA marketing consent, captured at checkout and stored on the order row.
--
-- Two columns, because one cannot carry the record. `sms_marketing_consent` is WHAT
-- was agreed to; `consent_at` is the evidence of WHEN, which is the half that is
-- asked for in a complaint. A boolean on its own cannot tell consent given today
-- from the default inherited by every row written before this migration.
--
-- `NOT NULL DEFAULT false` is the ruling, not a convenience: consent is something a
-- customer does, so its absence is a refusal and never an unknown. That also makes
-- the backfill of every existing order correct by construction — none of them were
-- ever shown a consent box, so false is the true answer for all of them, and
-- `consent_at` stays NULL to say the same thing a second way.
--
-- Marketing only. Transactional messages — the owner's new-order text, "your order is
-- ready" — are not gated on either column, and nothing in the fan-out reads them.
--
-- Guarded so a reset Neon branch can re-run it; no GRANT needed, because `app_user`'s
-- privileges on `orders` are table-level (0008) and therefore cover a new column.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "sms_marketing_consent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "consent_at" timestamp with time zone;
