-- Tenancy, enforced by the database.
--
-- The application already filters by location_id everywhere. This migration is the
-- answer to the day it does not: one forgotten WHERE clause must not hand a
-- restaurant another restaurant's orders. Everything below is written by hand
-- because drizzle-kit models none of it — roles, grants, RLS, policies.
--
-- How it works: `withLocation()` opens a transaction and sets the GUC
-- `app.location_id` with SET LOCAL. Every policy reads that GUC. A connection that
-- never sets it sees **nothing** — the read is NULL, `location_id = NULL` is NULL,
-- and NULL is not true. Default deny.
--
-- `nullif(..., '')` is not decoration. `current_setting(x, true)` returns NULL only
-- while the GUC has never been defined on that backend; once any transaction has
-- SET LOCAL it, later transactions read back the empty string instead. On a pooled
-- connection that is the normal case, and a bare `''::uuid` raises 22P02 — so
-- without the nullif, every unscoped query on these tables fails with a type error
-- rather than quietly returning nothing. Fail-closed either way, but only one of
-- those is debuggable.
--
-- Two things make this real rather than decorative, and breaking either one turns
-- the whole file into a no-op:
--
--   1. **The app must not connect as the table owner.** RLS does not bind a table's
--      owner, and the Neon owner role additionally has BYPASSRLS. Hence `app_user`,
--      created here, owning nothing. `.env.test` / `.env.local` point DATABASE_URL
--      at app_user; MIGRATION_DATABASE_URL keeps the owner for drizzle-kit.
--   2. **The role needs a password, and it is not in this file.** A literal here
--      would be a committed credential. `scripts/create-app-user.mjs` sets it from
--      APP_USER_PASSWORD (or generates one) and writes the connection string into
--      the env file. Run it once per Neon branch, after this migration.
--
-- Tables deliberately NOT covered, because they are not location-scoped data:
-- organizations, locations, memberships (the tenancy root — `withLocation` needs a
-- location to exist before it can scope to one) and the hours tables
-- (business_hours, holiday_closures, order_pauses), which `isOpenAt` reads through
-- the stateless http driver. Both are named in CLAUDE.md as open work.

-- A role, not a login yet: no password is set here, so nothing can connect as it
-- until scripts/create-app-user.mjs runs. Idempotent — Neon branches get reset.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN;
  END IF;
END $$;--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO app_user;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;--> statement-breakpoint

-- Granted on purpose, and only here: `order_events` must be refused by the
-- append-only trigger (0006), not by a missing privilege. Without this the suite's
-- "cannot be truncated" test would pass for the wrong reason and stop proving the
-- trigger exists. RLS does not filter TRUNCATE, so the privilege is the only gate
-- before the trigger — which is exactly the gate we want to watch fail.
GRANT TRUNCATE ON TABLE order_events TO app_user;--> statement-breakpoint

-- Tables added by later migrations inherit the grant instead of being silently
-- unreadable. They do NOT inherit a policy — every new location-scoped table has
-- to declare its own, which is the point.
DO $$ BEGIN
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user',
    current_user);
END $$;--> statement-breakpoint

--
-- Tables that carry location_id themselves.
--
ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "orders_location_scope" ON "orders";--> statement-breakpoint
CREATE POLICY "orders_location_scope" ON "orders" FOR ALL
  USING (location_id = nullif(current_setting('app.location_id', true), '')::uuid)
  WITH CHECK (location_id = nullif(current_setting('app.location_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE "menus" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "menus_location_scope" ON "menus";--> statement-breakpoint
CREATE POLICY "menus_location_scope" ON "menus" FOR ALL
  USING (location_id = nullif(current_setting('app.location_id', true), '')::uuid)
  WITH CHECK (location_id = nullif(current_setting('app.location_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE "modifier_groups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "modifier_groups_location_scope" ON "modifier_groups";--> statement-breakpoint
CREATE POLICY "modifier_groups_location_scope" ON "modifier_groups" FOR ALL
  USING (location_id = nullif(current_setting('app.location_id', true), '')::uuid)
  WITH CHECK (location_id = nullif(current_setting('app.location_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE "availability_windows" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "availability_windows_location_scope" ON "availability_windows";--> statement-breakpoint
CREATE POLICY "availability_windows_location_scope" ON "availability_windows" FOR ALL
  USING (location_id = nullif(current_setting('app.location_id', true), '')::uuid)
  WITH CHECK (location_id = nullif(current_setting('app.location_id', true), '')::uuid);--> statement-breakpoint

-- menu_snapshots is insert-only by convention; RLS still covers UPDATE/DELETE so a
-- cross-tenant one is not even visible to attempt. The payload is a whole menu.
ALTER TABLE "menu_snapshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "menu_snapshots_location_scope" ON "menu_snapshots";--> statement-breakpoint
CREATE POLICY "menu_snapshots_location_scope" ON "menu_snapshots" FOR ALL
  USING (location_id = nullif(current_setting('app.location_id', true), '')::uuid)
  WITH CHECK (location_id = nullif(current_setting('app.location_id', true), '')::uuid);--> statement-breakpoint

--
-- Tables with no location_id of their own. Each polices via its parent chain, so
-- the column does not have to be denormalised onto every child — and a child can
-- never disagree with its parent about which restaurant it belongs to.
--
ALTER TABLE "menu_categories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "menu_categories_location_scope" ON "menu_categories";--> statement-breakpoint
CREATE POLICY "menu_categories_location_scope" ON "menu_categories" FOR ALL
  USING (EXISTS (
    SELECT 1 FROM menus m
    WHERE m.id = menu_categories.menu_id
      AND m.location_id = nullif(current_setting('app.location_id', true), '')::uuid))
  WITH CHECK (EXISTS (
    SELECT 1 FROM menus m
    WHERE m.id = menu_categories.menu_id
      AND m.location_id = nullif(current_setting('app.location_id', true), '')::uuid));--> statement-breakpoint

ALTER TABLE "menu_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "menu_items_location_scope" ON "menu_items";--> statement-breakpoint
CREATE POLICY "menu_items_location_scope" ON "menu_items" FOR ALL
  USING (EXISTS (
    SELECT 1 FROM menu_categories c JOIN menus m ON m.id = c.menu_id
    WHERE c.id = menu_items.category_id
      AND m.location_id = nullif(current_setting('app.location_id', true), '')::uuid))
  WITH CHECK (EXISTS (
    SELECT 1 FROM menu_categories c JOIN menus m ON m.id = c.menu_id
    WHERE c.id = menu_items.category_id
      AND m.location_id = nullif(current_setting('app.location_id', true), '')::uuid));--> statement-breakpoint

ALTER TABLE "modifier_options" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "modifier_options_location_scope" ON "modifier_options";--> statement-breakpoint
CREATE POLICY "modifier_options_location_scope" ON "modifier_options" FOR ALL
  USING (EXISTS (
    SELECT 1 FROM modifier_groups g
    WHERE g.id = modifier_options.group_id
      AND g.location_id = nullif(current_setting('app.location_id', true), '')::uuid))
  WITH CHECK (EXISTS (
    SELECT 1 FROM modifier_groups g
    WHERE g.id = modifier_options.group_id
      AND g.location_id = nullif(current_setting('app.location_id', true), '')::uuid));--> statement-breakpoint

-- Both parents, not either: this join table is the one place a link could be built
-- across tenants, and it must satisfy the item's location and the group's.
ALTER TABLE "item_modifier_groups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "item_modifier_groups_location_scope" ON "item_modifier_groups";--> statement-breakpoint
CREATE POLICY "item_modifier_groups_location_scope" ON "item_modifier_groups" FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM menu_items i
        JOIN menu_categories c ON c.id = i.category_id
        JOIN menus m ON m.id = c.menu_id
      WHERE i.id = item_modifier_groups.item_id
        AND m.location_id = nullif(current_setting('app.location_id', true), '')::uuid)
    AND EXISTS (
      SELECT 1 FROM modifier_groups g
      WHERE g.id = item_modifier_groups.group_id
        AND g.location_id = nullif(current_setting('app.location_id', true), '')::uuid))
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM menu_items i
        JOIN menu_categories c ON c.id = i.category_id
        JOIN menus m ON m.id = c.menu_id
      WHERE i.id = item_modifier_groups.item_id
        AND m.location_id = nullif(current_setting('app.location_id', true), '')::uuid)
    AND EXISTS (
      SELECT 1 FROM modifier_groups g
      WHERE g.id = item_modifier_groups.group_id
        AND g.location_id = nullif(current_setting('app.location_id', true), '')::uuid));--> statement-breakpoint

ALTER TABLE "order_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "order_items_location_scope" ON "order_items";--> statement-breakpoint
CREATE POLICY "order_items_location_scope" ON "order_items" FOR ALL
  USING (EXISTS (
    SELECT 1 FROM orders o
    WHERE o.id = order_items.order_id
      AND o.location_id = nullif(current_setting('app.location_id', true), '')::uuid))
  WITH CHECK (EXISTS (
    SELECT 1 FROM orders o
    WHERE o.id = order_items.order_id
      AND o.location_id = nullif(current_setting('app.location_id', true), '')::uuid));--> statement-breakpoint

ALTER TABLE "order_item_modifiers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "order_item_modifiers_location_scope" ON "order_item_modifiers";--> statement-breakpoint
CREATE POLICY "order_item_modifiers_location_scope" ON "order_item_modifiers" FOR ALL
  USING (EXISTS (
    SELECT 1 FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE oi.id = order_item_modifiers.order_item_id
      AND o.location_id = nullif(current_setting('app.location_id', true), '')::uuid))
  WITH CHECK (EXISTS (
    SELECT 1 FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE oi.id = order_item_modifiers.order_item_id
      AND o.location_id = nullif(current_setting('app.location_id', true), '')::uuid));--> statement-breakpoint

-- The append-only trigger (0006) already refuses UPDATE and DELETE here. The policy
-- is not redundant with it: without one, another restaurant could still *read* the
-- audit trail, and the audit trail is where the phone numbers are.
ALTER TABLE "order_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "order_events_location_scope" ON "order_events";--> statement-breakpoint
CREATE POLICY "order_events_location_scope" ON "order_events" FOR ALL
  USING (EXISTS (
    SELECT 1 FROM orders o
    WHERE o.id = order_events.order_id
      AND o.location_id = nullif(current_setting('app.location_id', true), '')::uuid))
  WITH CHECK (EXISTS (
    SELECT 1 FROM orders o
    WHERE o.id = order_events.order_id
      AND o.location_id = nullif(current_setting('app.location_id', true), '')::uuid));
