CREATE TABLE "printer_probe_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"serial" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"polls" integer DEFAULT 1 NOT NULL,
	"alerted_at" timestamp with time zone,
	CONSTRAINT "printer_probe_events_serial_unique" UNIQUE("serial")
);
--> statement-breakpoint
ALTER TABLE "printers" ADD COLUMN "last_alert_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "printer_probe_events_last_seen_idx" ON "printer_probe_events" USING btree ("last_seen_at");