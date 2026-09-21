-- Sales tax was stored in the wrong unit, and New York City is why.
--
-- `locations.tax_rate_bps` was an integer count of basis points, and `taxCentsFor`
-- divided by 10,000. NYC's rate on prepared food is **8.875%** — 887.5 basis points —
-- which an integer bps column cannot represent at all. Every location in the city we
-- are launching in would have been charged 8.75% or 8.90%: on a $74.60 ticket that is
-- eight cents, and on a year of a restaurant's sales it is a number their accountant
-- has to explain to New York State.
--
-- So the unit changes rather than the column's type: **parts per 100,000**, still an
-- integer (a `numeric` rate read back as a string or a float would put a rounding
-- opinion in the one place this codebase refuses to have one), which covers every US
-- jurisdiction — rates are quoted to at most three decimal places.
--
-- Two statements, and the order matters:
--
--   1. RENAME, so no data moves and no column is dropped. A drop-and-add would lose
--      every rate on the table and could not restore them.
--   2. MULTIPLY every existing value by ten, which is what makes the rename
--      semantically a no-op: a row that said 875 bps (8.75%) now says 8750 per
--      100,000 (8.75%). Nothing is repriced by this migration.
--
-- Kashi's own rate is corrected separately and deliberately, by `npm run seed:kashi`,
-- which sets 8875 — the real NYC rate the old unit could not hold. That is a change of
-- what we charge, so it belongs in a seed a human runs and not in a migration that
-- runs itself.
--
-- Idempotent, because Neon branches get reset and this file may be re-applied: both
-- statements are guarded on the column that is actually there, so a second run is a
-- no-op rather than a second ×10.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'locations' AND column_name = 'tax_rate_bps'
  ) THEN
    ALTER TABLE "locations" RENAME COLUMN "tax_rate_bps" TO "tax_rate_per_100k";
    UPDATE "locations" SET "tax_rate_per_100k" = "tax_rate_per_100k" * 10;
  END IF;
END $$;
