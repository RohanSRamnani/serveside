-- Reordered by hand: drizzle-kit emitted the FK before the UNIQUE it references,
-- and Postgres refuses a foreign key whose target columns are not unique yet.
ALTER TABLE "menu_snapshots" ADD CONSTRAINT "menu_snapshots_location_id_id_unq" UNIQUE("location_id","id");--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_menu_snapshot_id_menu_snapshots_id_fk";--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_snapshot_location_fk" FOREIGN KEY ("location_id","menu_snapshot_id") REFERENCES "public"."menu_snapshots"("location_id","id") ON DELETE no action ON UPDATE no action;
