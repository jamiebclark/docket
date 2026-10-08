CREATE TYPE "public"."activity_event_kind" AS ENUM('target_published', 'target_failed', 'target_ambiguous', 'target_retry_scheduled', 'target_resolved', 'account_needs_reauth', 'account_connect_failed');--> statement-breakpoint
CREATE TYPE "public"."activity_outcome" AS ENUM('published', 'failed', 'ambiguous', 'retrying', 'resolved', 'needs_reauth', 'connect_failed');--> statement-breakpoint
CREATE TABLE "activity_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "activity_events_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"kind" "activity_event_kind" NOT NULL,
	"outcome" "activity_outcome" NOT NULL,
	"post_id" uuid,
	"post_target_id" uuid,
	"social_account_id" uuid,
	"provider_key" text,
	"provider_keys" text[] NOT NULL,
	"group_key" text,
	"actor_user_id" uuid,
	"actor_api_key_id" uuid,
	"message" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activity_events_seq_uq" UNIQUE("seq"),
	CONSTRAINT "activity_events_kind_outcome" CHECK ((kind = 'target_published' AND outcome = 'published') OR (kind = 'target_failed' AND outcome = 'failed') OR (kind = 'target_ambiguous' AND outcome = 'ambiguous') OR (kind = 'target_retry_scheduled' AND outcome = 'retrying') OR (kind = 'target_resolved' AND outcome = 'resolved') OR (kind = 'account_needs_reauth' AND outcome = 'needs_reauth') OR (kind = 'account_connect_failed' AND outcome = 'connect_failed')),
	CONSTRAINT "activity_events_message_len" CHECK (char_length("activity_events"."message") BETWEEN 1 AND 500),
	CONSTRAINT "activity_events_details_size" CHECK (octet_length("activity_events"."details"::text) <= 2000),
	CONSTRAINT "activity_events_ms" CHECK ("activity_events"."occurred_at" = date_trunc('milliseconds', "activity_events"."occurred_at")),
	CONSTRAINT "activity_events_target_pair" CHECK (("activity_events"."post_id" IS NULL) = ("activity_events"."post_target_id" IS NULL)),
	CONSTRAINT "activity_events_target_kinds" CHECK (("activity_events"."kind"::text NOT LIKE 'target_%' OR ("activity_events"."post_target_id" IS NOT NULL AND "activity_events"."social_account_id" IS NOT NULL AND "activity_events"."provider_key" IS NOT NULL)) AND ("activity_events"."kind"::text NOT LIKE 'account_%' OR "activity_events"."post_target_id" IS NULL)),
	CONSTRAINT "activity_events_needs_reauth_account" CHECK ("activity_events"."kind" <> 'account_needs_reauth' OR "activity_events"."social_account_id" IS NOT NULL),
	CONSTRAINT "activity_events_provider_keys" CHECK (cardinality("activity_events"."provider_keys") >= 1 AND ("activity_events"."provider_key" IS NULL OR "activity_events"."provider_keys" = ARRAY["activity_events"."provider_key"])),
	CONSTRAINT "activity_events_group_key_format" CHECK ("activity_events"."group_key" IS NULL OR "activity_events"."group_key" ~ '^[a-z0-9-]+$')
);
--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_api_key_fk" FOREIGN KEY ("project_id","actor_api_key_id") REFERENCES "public"."api_keys"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_events_project_time_idx" ON "activity_events" USING btree ("project_id","occurred_at" DESC NULLS LAST,"seq" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "activity_events_project_outcome_time_idx" ON "activity_events" USING btree ("project_id","outcome","occurred_at" DESC NULLS LAST,"seq" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "activity_events_project_account_time_idx" ON "activity_events" USING btree ("project_id","social_account_id","occurred_at" DESC NULLS LAST,"seq" DESC NULLS LAST) WHERE "activity_events"."social_account_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "activity_events_project_target_idx" ON "activity_events" USING btree ("project_id","post_target_id") WHERE "activity_events"."post_target_id" IS NOT NULL;