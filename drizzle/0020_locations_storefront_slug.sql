-- The public routing key gets its own column, because `locations.slug` cannot be one.
--
-- `slug` is unique **per org** (`locations_org_slug_unique`, migration 0014) and that
-- is deliberate: every authed path resolves the Clerk org first and the slug inside it
-- (`src/lib/authz.ts`), so two restaurants may both call a location `main` without
-- pushing `kashi-main` into every staff URL. A customer has no org to resolve inside,
-- so the public storefront is the one slug-first lookup in the codebase — and on that
-- lookup an org-scoped key is a coin toss between tenants. One restaurant's menu at
-- another's URL sends real food to the wrong kitchen and real money to the wrong
-- Stripe account.
--
-- So: `storefront_slug`, NOT NULL and unique **platform-wide**. Kashi is also the
-- plain illustration of why it is a second column rather than a stricter first one —
-- their location slug is `livingston` (their street, which is how their staff say
-- which shop) and the customer URL has to read `/order/kashi`.
--
-- Seven statements, and the order is the whole point: **a NOT NULL column is never
-- left unfilled mid-flight.** Added nullable, backfilled, checked, and only then
-- constrained — an `ADD COLUMN ... NOT NULL` on a table with rows fails outright, and
-- an `ADD CONSTRAINT UNIQUE` on a half-backfilled table fails with an error that says
-- nothing about which restaurants need a human.
--
-- Idempotent throughout, because Neon branches get reset and this file may be
-- re-applied: the column is added `IF NOT EXISTS`, every backfill pass is guarded on
-- `storefront_slug IS NULL`, `SET NOT NULL` is a no-op when it is already set, and the
-- constraint is added only if it is not already on the table. A second run changes
-- nothing.
ALTER TABLE "locations" ADD COLUMN IF NOT EXISTS "storefront_slug" text;--> statement-breakpoint

-- Pass 1 — **Kashi**, the pilot restaurant and the reason this column exists: their
-- storefront slug is their *org* slug, `kashi`. Guarded on the org having exactly one
-- location, so the day they open a second shop this pass stops applying and passes 2–3
-- name them `kashi-livingston` and `kashi-<the new street>` instead, which is what the
-- plan says a multi-location tenant should read. `npm run seed:kashi` sets the same
-- value from `scripts/seed-kashi.ts`, so the seed and this backfill cannot drift.
UPDATE "locations" l
SET "storefront_slug" = o."slug"
FROM "organizations" o
WHERE o."id" = l."org_id"
  AND o."slug" = 'kashi'
  AND l."storefront_slug" IS NULL
  AND (SELECT count(*) FROM "locations" x WHERE x."org_id" = l."org_id") = 1;--> statement-breakpoint

-- Pass 2 — every location whose own `slug` is *already* unique across the platform
-- keeps it, so no existing URL changes shape for no reason. `count(*) = 1` over the
-- whole table is exactly the question "is this slug globally unambiguous"; the
-- NOT EXISTS keeps pass 1's `kashi` from being handed out a second time.
UPDATE "locations" l
SET "storefront_slug" = l."slug"
WHERE l."storefront_slug" IS NULL
  AND (SELECT count(*) FROM "locations" x WHERE x."slug" = l."slug") = 1
  AND NOT EXISTS (SELECT 1 FROM "locations" y WHERE y."storefront_slug" = l."slug");--> statement-breakpoint

-- Pass 3 — the genuinely ambiguous remainder: two tenants sharing a slug (`main`,
-- typically), which is legal in `slug` and forbidden here. Qualified with the org
-- slug, which `organizations.slug` already guarantees is unique, so the pair is too.
UPDATE "locations" l
SET "storefront_slug" = o."slug" || '-' || l."slug"
FROM "organizations" o
WHERE o."id" = l."org_id"
  AND l."storefront_slug" IS NULL;--> statement-breakpoint

-- Pass 4 — refuse to finish on anything the three passes could not settle, and say
-- which rows they are. Two leftovers are conceivable: a row still NULL, and a
-- collision the passes could not see (`org 'a' + slug 'b-c'` and `org 'a-b' + slug 'c'`
-- qualify to the same string). Both want a human choosing a slug, not a constraint
-- error naming a column. This block raises **before** anything is made permanent, so
-- the migration is a no-op on the way out and can be re-run after the fix.
DO $$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg(format('%s=%s', l."id", coalesce(l."storefront_slug", '<null>')), ', ')
  INTO offenders
  FROM "locations" l
  WHERE l."storefront_slug" IS NULL
     OR l."storefront_slug" IN (
       SELECT "storefront_slug" FROM "locations"
       WHERE "storefront_slug" IS NOT NULL
       GROUP BY "storefront_slug" HAVING count(*) > 1
     );

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'storefront_slug backfill left locations without a unique public slug: %', offenders
      USING HINT = 'Set a distinct storefront_slug on each of those rows by hand, then re-run this migration.';
  END IF;
END $$;--> statement-breakpoint

ALTER TABLE "locations" ALTER COLUMN "storefront_slug" SET NOT NULL;--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'locations_storefront_slug_unique'
  ) THEN
    ALTER TABLE "locations" ADD CONSTRAINT "locations_storefront_slug_unique" UNIQUE("storefront_slug");
  END IF;
END $$;
