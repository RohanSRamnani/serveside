-- order_events is append-only. Written by hand (drizzle-kit does not model triggers)
-- and kept because "we only ever insert" is a promise the next person in a hurry
-- breaks, and the value of the table in a chargeback dispute is precisely that no
-- one could have edited it after the fact.
--
-- Statement-level, so a no-op `DELETE ... WHERE false` is refused too: the attempt
-- is the bug, not the row count. TRUNCATE is covered as well, since it is the one
-- way to empty a table without a DELETE.
CREATE OR REPLACE FUNCTION order_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'order_events is append-only: % is not allowed on this table', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS order_events_append_only ON order_events;
--> statement-breakpoint
CREATE TRIGGER order_events_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON order_events
  FOR EACH STATEMENT EXECUTE FUNCTION order_events_append_only();
