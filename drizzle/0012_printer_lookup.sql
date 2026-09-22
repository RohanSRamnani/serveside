-- printer_lookup: the **one** deliberate hole in row-level security in this repo.
--
-- The problem it solves is a genuine chicken-and-egg, not a convenience. A Star
-- CloudPRNT printer polls us (pull protocol — there is no inbound firewall hole at a
-- restaurant), and the only thing it can present is the MAC address burnt into it.
-- So the route has to turn a serial into a location before it can open
-- `withLocation`. But `printers` is RLS-policed on `location_id`, and an unscoped
-- read returns **nothing** — the location that would make the read work is exactly
-- what the read is for.
--
-- Three ways out, and only one of them is safe:
--
--   Grant app_user SELECT on printers outside RLS   Wrong. `printers` is a tenant
--       table; taking it out of RLS to solve one lookup hands every row to every
--       unscoped query in the codebase, forever.
--   Denormalise the location onto something unpoliced   Wrong for the same reason,
--       and it puts a second copy of the tenancy fact where nothing keeps it honest.
--   A SECURITY DEFINER function with exactly this signature   What this is.
--
-- Why it is safe to have, stated plainly so the next reader does not have to re-derive it:
--
--   * **The serial is the credential.** Knowing a printer's MAC is the only way to
--     get anything out of this, and a MAC is what the physical unit in the kitchen
--     holds. Guessing one is guessing a 48-bit value that we provisioned.
--   * **It returns ids, and only ids.** No serial, no last_seen_at, no row — nothing
--     that could be used to enumerate printers or learn anything about a restaurant.
--     A caller who already knows the serial learns which location it belongs to.
--   * **Unknown serial returns zero rows**, which is what makes "an unknown printer
--     must not be able to register itself" enforceable in the route: there is no
--     upsert here and no INSERT privilege being lent. The function cannot create a
--     printer, only recognise one.
--   * **Everything after it is ordinary scoped code.** The route opens
--     `withLocation(location_id)` and RLS polices the rest — the queue read, the
--     heartbeat write, the job payload. This function widens nothing past the lookup.
--
-- It runs as `serveside_owner`, which owns `printers`, and RLS does not bind a
-- table's owner. That is the mechanism, and it is also the fragility: adding
-- `FORCE ROW LEVEL SECURITY` to `printers` would make this return nothing and stop
-- every kitchen printing, silently. `src/app/api/printers/cloudprnt.test.ts` asserts
-- the bypass still works for that reason.
--
-- `SET search_path` is not decoration either: without it, a role able to create
-- objects could shadow `printers` with its own table and have the owner read it —
-- the classic SECURITY DEFINER hijack. `pg_temp` goes last so a temp table cannot
-- take precedence.
--
-- Idempotent (DROP ... IF EXISTS first): Neon branches get reset, and every
-- migration in this repo has to survive a replay.

DROP FUNCTION IF EXISTS "printer_lookup"(text);--> statement-breakpoint

CREATE FUNCTION "printer_lookup"(p_serial text)
  RETURNS TABLE (printer_id uuid, location_id uuid)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT p.id, p.location_id FROM public.printers p WHERE p.serial = p_serial
$$;--> statement-breakpoint

-- A new function is EXECUTE-to-PUBLIC by default. This REVOKE is what makes the
-- grant below the whole of the access list, and it is load-bearing.
REVOKE ALL ON FUNCTION "printer_lookup"(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "printer_lookup"(text) TO app_user;
