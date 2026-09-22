CREATE INDEX "orders_location_created_idx" ON "orders" USING btree ("location_id","created_at");--> statement-breakpoint
CREATE INDEX "orders_location_status_idx" ON "orders" USING btree ("location_id","status");--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_org_slug_unique" UNIQUE("org_id","slug");