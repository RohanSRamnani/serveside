-- Three things, all of them tenancy.
--
-- 1. The ENABLE statements drizzle-kit generated once the 15 policed tables gained
--    `.enableRLS()` in the schema. Eleven of them were already enabled by 0008 and
--    re-enabling is a no-op; what actually changes is the *snapshot*. Before this,
--    meta/0008_snapshot.json claimed `isRLSEnabled: false` for every table while the
--    database had RLS on — so `drizzle-kit push` would have "corrected" the database
--    by emitting DISABLE ROW LEVEL SECURITY across the board and silently turning
--    every policy off. CLAUDE.md now forbids `push` in this repo as well; this makes
--    the belt match the braces either way.
--
-- 2. RLS on the hours tables. They were left out of 0008 because they are not
--    sensitive to read — and that was the wrong test. `app_user` had DELETE on all
--    three, so one restaurant could delete another's `business_hours` (closing them),
--    or insert an `order_pauses` row against another location and stop them taking
--    orders. That is a revenue denial-of-service, not a privacy question. All three
--    carry `location_id`, so the direct policy applies with no subquery.
--
-- 3. `menu_categories.availability_window_id` could point at another tenant's window.
--    Referential-integrity checks bypass row security, so the FK would not have caught
--    it and neither would any WHERE clause; the category would then be gated by a
--    schedule its owner cannot see or edit.

ALTER TABLE "availability_windows" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "item_modifier_groups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "menu_categories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "menu_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "menus" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "modifier_groups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "modifier_options" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "menu_snapshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "business_hours" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "holiday_closures" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "order_pauses" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "order_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "order_item_modifiers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "order_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

--
-- The hours tables. Direct location_id, same nullif pattern as 0008 — see that file
-- for why the nullif is load-bearing rather than decorative.
--
DROP POLICY IF EXISTS "business_hours_location_scope" ON "business_hours";--> statement-breakpoint
CREATE POLICY "business_hours_location_scope" ON "business_hours" FOR ALL
  USING (location_id = nullif(current_setting('app.location_id', true), '')::uuid)
  WITH CHECK (location_id = nullif(current_setting('app.location_id', true), '')::uuid);--> statement-breakpoint

DROP POLICY IF EXISTS "holiday_closures_location_scope" ON "holiday_closures";--> statement-breakpoint
CREATE POLICY "holiday_closures_location_scope" ON "holiday_closures" FOR ALL
  USING (location_id = nullif(current_setting('app.location_id', true), '')::uuid)
  WITH CHECK (location_id = nullif(current_setting('app.location_id', true), '')::uuid);--> statement-breakpoint

DROP POLICY IF EXISTS "order_pauses_location_scope" ON "order_pauses";--> statement-breakpoint
CREATE POLICY "order_pauses_location_scope" ON "order_pauses" FOR ALL
  USING (location_id = nullif(current_setting('app.location_id', true), '')::uuid)
  WITH CHECK (location_id = nullif(current_setting('app.location_id', true), '')::uuid);--> statement-breakpoint

--
-- menu_categories, replacing the 0008 policy: same USING, plus a WITH CHECK that the
-- availability window it points at belongs to the same location.
--
-- Policy-side rather than a composite FK, deliberately. A composite FK would need
-- `location_id` denormalised onto menu_categories, and the standing ruling for this
-- schema is that child tables carry no location_id and derive it from their parent.
-- The cost is that this binds `app_user` and not the owner — acceptable, since the
-- owner is drizzle-kit and nothing else.
--
-- In WITH CHECK only, not USING. USING governs visibility, and a category with a bad
-- window is still genuinely this location's category: hiding it would mean the owner
-- could not see the row to fix it. WITH CHECK is what refuses the write, on INSERT
-- and on any UPDATE that sets the column.
--
-- `IS NULL OR` because the column is nullable and a category with no window is the
-- common case — without it, every ordinary category insert would be refused.
DROP POLICY IF EXISTS "menu_categories_location_scope" ON "menu_categories";--> statement-breakpoint
CREATE POLICY "menu_categories_location_scope" ON "menu_categories" FOR ALL
  USING (EXISTS (
    SELECT 1 FROM menus m
    WHERE m.id = menu_categories.menu_id
      AND m.location_id = nullif(current_setting('app.location_id', true), '')::uuid))
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM menus m
      WHERE m.id = menu_categories.menu_id
        AND m.location_id = nullif(current_setting('app.location_id', true), '')::uuid)
    AND (
      menu_categories.availability_window_id IS NULL
      OR EXISTS (
        SELECT 1 FROM availability_windows w
        WHERE w.id = menu_categories.availability_window_id
          AND w.location_id = nullif(current_setting('app.location_id', true), '')::uuid)));
