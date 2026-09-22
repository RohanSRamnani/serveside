-- The three tables 0010 created, made usable and made safe.
--
-- 0008 revoked default privileges on future tables from `app_user` on purpose, so
-- every table added after it is unreadable until its own migration grants it — the
-- moment someone has to decide out loud whether it is tenant-scoped. This is that
-- decision for `printers`, `print_jobs` and `webhook_events`.
--
--   printers, print_jobs   location-scoped. Both carry `location_id`, so the direct
--                          policy applies with no subquery, exactly as 0009's hours
--                          tables do. See that file for why the `nullif` is
--                          load-bearing rather than decorative.
--
--   webhook_events         platform-global and **exempt**, the first table outside
--                          the tenancy root to be. A webhook is authenticated by its
--                          signature and arrives before anything knows whose it is:
--                          the location is inside the payload. There is no scope to
--                          open at the moment the row must be written, and opening
--                          one from the *unverified* body would be scoping to
--                          whatever the caller claimed. The handler opens
--                          `withLocation` for the order write, which is where
--                          tenancy is actually enforced. Named in CLAUDE.md and in
--                          the catalog assertion in `src/repo/rls.test.ts`.
--
-- Idempotent throughout (DROP POLICY IF EXISTS, plain GRANT): Neon branches get reset
-- and every migration in this repo has to survive a replay.

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "printers" TO app_user;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "print_jobs" TO app_user;--> statement-breakpoint

-- DELETE is granted here for one specific reason, and it is not housekeeping: the
-- webhook handler **releases its claim** — deletes the row it just inserted — when
-- handling fails, so the 5xx Stripe retries against can be processed instead of
-- landing on a burnt id. Without DELETE, a failed handler would silently eat the event.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "webhook_events" TO app_user;--> statement-breakpoint

DROP POLICY IF EXISTS "printers_location_scope" ON "printers";--> statement-breakpoint
CREATE POLICY "printers_location_scope" ON "printers" FOR ALL
  USING (location_id = nullif(current_setting('app.location_id', true), '')::uuid)
  WITH CHECK (location_id = nullif(current_setting('app.location_id', true), '')::uuid);--> statement-breakpoint

-- `print_jobs` gets one conjunct the hours tables do not need: the order it prints
-- must belong to the same location as the job.
--
-- Referential-integrity checks bypass row security, so the FK to `orders` would have
-- allowed a job whose `location_id` is one restaurant and whose `order_id` is
-- another's — and the consequence is not abstract. A print job is a physical ticket:
-- that row prints one kitchen's order, with its customer's name and phone number on
-- it, on a different kitchen's printer.
--
-- Policy-side rather than a composite FK, following the ruling 0009 made for
-- `menu_categories.availability_window_id`: child tables here carry no denormalised
-- `location_id` on the *parent* side to point at, and a composite FK would need
-- `UNIQUE (orders.location_id, id)` added first. The cost is that this binds
-- `app_user` and not the owner — acceptable, since the owner is drizzle-kit and
-- nothing else.
--
-- In WITH CHECK only, not USING, for the same reason as 0009: USING governs
-- visibility, and a mismatched job is still genuinely this location's row to see and
-- to fix. WITH CHECK is what refuses to write it.
DROP POLICY IF EXISTS "print_jobs_location_scope" ON "print_jobs";--> statement-breakpoint
CREATE POLICY "print_jobs_location_scope" ON "print_jobs" FOR ALL
  USING (location_id = nullif(current_setting('app.location_id', true), '')::uuid)
  WITH CHECK (
    location_id = nullif(current_setting('app.location_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM orders o
      WHERE o.id = print_jobs.order_id
        AND o.location_id = nullif(current_setting('app.location_id', true), '')::uuid));
