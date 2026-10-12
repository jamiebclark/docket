CREATE TABLE "notification_change_marker" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"attention_writes" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_change_marker_single_row" CHECK ("notification_change_marker"."id")
);
--> statement-breakpoint
-- The one row the table is designed to hold. Without it the probe reads NULL and never sees a change,
-- so it is seeded here rather than left to the first writer.
INSERT INTO "notification_change_marker" ("id") VALUES (true) ON CONFLICT DO NOTHING;
