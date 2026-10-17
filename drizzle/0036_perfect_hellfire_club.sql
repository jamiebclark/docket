CREATE TYPE "public"."engagement_draft_origin" AS ENUM('model', 'person');--> statement-breakpoint
CREATE TYPE "public"."engagement_draft_state" AS ENUM('needs_review', 'approved', 'rejected', 'discarded');--> statement-breakpoint
CREATE TYPE "public"."engagement_item_kind" AS ENUM('reply', 'comment', 'mention', 'direct_message');--> statement-breakpoint
CREATE TYPE "public"."engagement_item_state" AS ENUM('waiting', 'answered', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."engagement_send_state" AS ENUM('none', 'waiting', 'sending', 'sent', 'failed', 'ambiguous');--> statement-breakpoint
ALTER TYPE "public"."activity_event_kind" ADD VALUE 'engagement_received';--> statement-breakpoint
ALTER TYPE "public"."activity_event_kind" ADD VALUE 'engagement_replied';--> statement-breakpoint
ALTER TYPE "public"."activity_event_kind" ADD VALUE 'engagement_ambiguous';--> statement-breakpoint
ALTER TYPE "public"."activity_outcome" ADD VALUE 'engagement';--> statement-breakpoint
CREATE TABLE "engagement_account_states" (
	"social_account_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"auto_draft" boolean DEFAULT false NOT NULL,
	"cursor" text,
	"provider_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"backfilling" boolean DEFAULT false NOT NULL,
	"read_lease_until" timestamp with time zone,
	"read_lease_owner" uuid,
	"read_not_before" timestamp with time zone,
	"last_read_at" timestamp with time zone,
	"last_item_at" timestamp with time zone,
	"consecutive_failures" smallint DEFAULT 0 NOT NULL,
	"last_error" text,
	"gap_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "engagement_account_states_lease_pair" CHECK (("engagement_account_states"."read_lease_until" IS NULL) = ("engagement_account_states"."read_lease_owner" IS NULL)),
	CONSTRAINT "engagement_account_states_failures_nonneg" CHECK ("engagement_account_states"."consecutive_failures" >= 0),
	CONSTRAINT "engagement_account_states_cursor_len" CHECK ("engagement_account_states"."cursor" IS NULL OR char_length("engagement_account_states"."cursor") <= 500),
	CONSTRAINT "engagement_account_states_provider_state_size" CHECK (octet_length("engagement_account_states"."provider_state"::text) <= 2000)
);
--> statement-breakpoint
CREATE TABLE "engagement_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"engagement_item_id" uuid NOT NULL,
	"social_account_id" uuid NOT NULL,
	"text" text NOT NULL,
	"origin" "engagement_draft_origin" NOT NULL,
	"voice_profile_id" uuid,
	"voice_profile_version" integer,
	"requested_by_user_id" uuid,
	"review_state" "engagement_draft_state" DEFAULT 'needs_review' NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by_user_id" uuid,
	"rejection_reason" text,
	"acknowledged_edit_at" timestamp with time zone,
	"send_state" "engagement_send_state" DEFAULT 'none' NOT NULL,
	"send_lease_until" timestamp with time zone,
	"send_lease_owner" uuid,
	"send_attempts" smallint DEFAULT 0 NOT NULL,
	"send_not_before" timestamp with time zone,
	"send_wait_reason" text,
	"external_reply_id" text,
	"external_reply_url" text,
	"sent_text" text,
	"sent_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "engagement_drafts_send_requires_approved" CHECK ("engagement_drafts"."send_state" = 'none' OR "engagement_drafts"."review_state" = 'approved'),
	CONSTRAINT "engagement_drafts_decision_names_person" CHECK ("engagement_drafts"."review_state" IN ('needs_review', 'discarded') OR ("engagement_drafts"."reviewed_at" IS NOT NULL AND "engagement_drafts"."reviewed_by_user_id" IS NOT NULL)),
	CONSTRAINT "engagement_drafts_model_origin_voice" CHECK ("engagement_drafts"."origin" <> 'model' OR ("engagement_drafts"."voice_profile_id" IS NOT NULL AND "engagement_drafts"."voice_profile_version" IS NOT NULL)),
	CONSTRAINT "engagement_drafts_sent_pair" CHECK (("engagement_drafts"."send_state" = 'sent') = ("engagement_drafts"."sent_at" IS NOT NULL)),
	CONSTRAINT "engagement_drafts_sent_fields" CHECK ("engagement_drafts"."send_state" <> 'sent' OR ("engagement_drafts"."external_reply_id" IS NOT NULL AND "engagement_drafts"."sent_text" IS NOT NULL)),
	CONSTRAINT "engagement_drafts_lease_pair" CHECK (("engagement_drafts"."send_lease_until" IS NULL) = ("engagement_drafts"."send_lease_owner" IS NULL)),
	CONSTRAINT "engagement_drafts_text_len" CHECK (char_length("engagement_drafts"."text") BETWEEN 1 AND 10000),
	CONSTRAINT "engagement_drafts_rejection_reason_len" CHECK ("engagement_drafts"."rejection_reason" IS NULL OR char_length("engagement_drafts"."rejection_reason") <= 500)
);
--> statement-breakpoint
CREATE TABLE "engagement_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"social_account_id" uuid NOT NULL,
	"provider_key" text NOT NULL,
	"kind" "engagement_item_kind" NOT NULL,
	"external_id" text NOT NULL,
	"text" text NOT NULL,
	"text_truncated" boolean DEFAULT false NOT NULL,
	"author_display_name" text,
	"author_handle" text,
	"author_external_id" text,
	"author_url" text,
	"author_identity_stable" boolean NOT NULL,
	"author_reachable" boolean DEFAULT true NOT NULL,
	"said_at" timestamp with time zone NOT NULL,
	"ingested_at" timestamp with time zone NOT NULL,
	"parent_external_id" text,
	"parent_post_id" uuid,
	"parent_post_target_id" uuid,
	"provider_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" "engagement_item_state" DEFAULT 'waiting' NOT NULL,
	"withdrawn_at" timestamp with time zone,
	"edited_upstream_at" timestamp with time zone,
	"answered_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"dismissed_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "engagement_items_identity_uq" UNIQUE("project_id","social_account_id","external_id"),
	CONSTRAINT "engagement_items_answered_pair" CHECK (("engagement_items"."state" = 'answered') = ("engagement_items"."answered_at" IS NOT NULL)),
	CONSTRAINT "engagement_items_dismissed_pair" CHECK (("engagement_items"."state" = 'dismissed') = ("engagement_items"."dismissed_at" IS NOT NULL)),
	CONSTRAINT "engagement_items_identity_stable" CHECK ("engagement_items"."author_identity_stable" IS FALSE OR "engagement_items"."author_external_id" IS NOT NULL),
	CONSTRAINT "engagement_items_external_id_len" CHECK (char_length("engagement_items"."external_id") BETWEEN 1 AND 200),
	CONSTRAINT "engagement_items_external_id_trimmed" CHECK (btrim("engagement_items"."external_id") = "engagement_items"."external_id"),
	CONSTRAINT "engagement_items_text_len" CHECK (char_length("engagement_items"."text") <= 10000),
	CONSTRAINT "engagement_items_author_display_name_len" CHECK ("engagement_items"."author_display_name" IS NULL OR char_length("engagement_items"."author_display_name") <= 200),
	CONSTRAINT "engagement_items_author_handle_len" CHECK ("engagement_items"."author_handle" IS NULL OR char_length("engagement_items"."author_handle") <= 200),
	CONSTRAINT "engagement_items_author_external_id_len" CHECK ("engagement_items"."author_external_id" IS NULL OR char_length("engagement_items"."author_external_id") <= 200),
	CONSTRAINT "engagement_items_author_url_len" CHECK ("engagement_items"."author_url" IS NULL OR char_length("engagement_items"."author_url") <= 2000),
	CONSTRAINT "engagement_items_provider_data_size" CHECK (octet_length("engagement_items"."provider_data"::text) <= 2000),
	CONSTRAINT "engagement_items_said_at_ms" CHECK ("engagement_items"."said_at" = date_trunc('milliseconds', "engagement_items"."said_at"))
);
--> statement-breakpoint
CREATE TABLE "engagement_reply_claims" (
	"project_id" uuid NOT NULL,
	"social_account_id" uuid NOT NULL,
	"item_external_id" text NOT NULL,
	"generation" smallint DEFAULT 1 NOT NULL,
	"draft_id" uuid NOT NULL,
	"engagement_item_id" uuid,
	"approved_by_user_id" uuid,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"release_reason" text,
	"released_by_user_id" uuid,
	CONSTRAINT "engagement_reply_claims_project_id_social_account_id_item_external_id_generation_pk" PRIMARY KEY("project_id","social_account_id","item_external_id","generation"),
	CONSTRAINT "engagement_reply_claims_generation_min" CHECK ("engagement_reply_claims"."generation" >= 1),
	CONSTRAINT "engagement_reply_claims_generation_release_pair" CHECK (("engagement_reply_claims"."generation" = 1) = ("engagement_reply_claims"."release_reason" IS NULL)),
	CONSTRAINT "engagement_reply_claims_release_reason_enum" CHECK ("engagement_reply_claims"."release_reason" IS NULL OR "engagement_reply_claims"."release_reason" IN ('definite_failure', 'member_decision')),
	CONSTRAINT "engagement_reply_claims_member_decision_named" CHECK ("engagement_reply_claims"."release_reason" <> 'member_decision' OR "engagement_reply_claims"."released_by_user_id" IS NOT NULL),
	CONSTRAINT "engagement_reply_claims_item_external_id_len" CHECK (char_length("engagement_reply_claims"."item_external_id") BETWEEN 1 AND 200),
	CONSTRAINT "engagement_reply_claims_item_external_id_trimmed" CHECK (btrim("engagement_reply_claims"."item_external_id") = "engagement_reply_claims"."item_external_id")
);
--> statement-breakpoint
ALTER TABLE "activity_events" DROP CONSTRAINT "activity_events_kind_outcome";--> statement-breakpoint
ALTER TABLE "notification_preferences" DROP CONSTRAINT "notification_preferences_kind_key";--> statement-breakpoint
DROP INDEX "activity_events_attention_seq_idx";--> statement-breakpoint
ALTER TABLE "engagement_account_states" ADD CONSTRAINT "engagement_account_states_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_account_states" ADD CONSTRAINT "engagement_account_states_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_drafts" ADD CONSTRAINT "engagement_drafts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_drafts" ADD CONSTRAINT "engagement_drafts_engagement_item_id_engagement_items_id_fk" FOREIGN KEY ("engagement_item_id") REFERENCES "public"."engagement_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_drafts" ADD CONSTRAINT "engagement_drafts_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_drafts" ADD CONSTRAINT "engagement_drafts_voice_profile_id_voice_profiles_id_fk" FOREIGN KEY ("voice_profile_id") REFERENCES "public"."voice_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_drafts" ADD CONSTRAINT "engagement_drafts_requested_by_user_id_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_drafts" ADD CONSTRAINT "engagement_drafts_reviewed_by_user_id_user_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_items" ADD CONSTRAINT "engagement_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_items" ADD CONSTRAINT "engagement_items_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_items" ADD CONSTRAINT "engagement_items_parent_post_id_posts_id_fk" FOREIGN KEY ("parent_post_id") REFERENCES "public"."posts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_items" ADD CONSTRAINT "engagement_items_parent_post_target_id_post_targets_id_fk" FOREIGN KEY ("parent_post_target_id") REFERENCES "public"."post_targets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_items" ADD CONSTRAINT "engagement_items_dismissed_by_user_id_user_id_fk" FOREIGN KEY ("dismissed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_reply_claims" ADD CONSTRAINT "engagement_reply_claims_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_reply_claims" ADD CONSTRAINT "engagement_reply_claims_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_reply_claims" ADD CONSTRAINT "engagement_reply_claims_approved_by_user_id_user_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_reply_claims" ADD CONSTRAINT "engagement_reply_claims_released_by_user_id_user_id_fk" FOREIGN KEY ("released_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "engagement_account_states_read_claim_idx" ON "engagement_account_states" USING btree ("read_not_before") WHERE "engagement_account_states"."read_lease_until" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "engagement_drafts_one_live_answer_uq" ON "engagement_drafts" USING btree ("engagement_item_id") WHERE "engagement_drafts"."review_state" = 'approved';--> statement-breakpoint
CREATE INDEX "engagement_drafts_project_review_idx" ON "engagement_drafts" USING btree ("project_id","review_state","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "engagement_drafts_send_claim_idx" ON "engagement_drafts" USING btree ("send_not_before","id") WHERE "engagement_drafts"."review_state" = 'approved' AND "engagement_drafts"."send_state" IN ('waiting', 'sending');--> statement-breakpoint
CREATE INDEX "engagement_drafts_item_thread_idx" ON "engagement_drafts" USING btree ("project_id","engagement_item_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "engagement_items_project_state_said_idx" ON "engagement_items" USING btree ("project_id","state","said_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "engagement_items_project_account_said_idx" ON "engagement_items" USING btree ("project_id","social_account_id","said_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "engagement_items_project_parent_idx" ON "engagement_items" USING btree ("project_id","parent_external_id") WHERE "engagement_items"."parent_external_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "engagement_items_said_idx" ON "engagement_items" USING btree ("said_at");--> statement-breakpoint
CREATE INDEX "engagement_reply_claims_window_idx" ON "engagement_reply_claims" USING btree ("project_id","social_account_id","claimed_at");--> statement-breakpoint
CREATE INDEX "activity_events_attention_seq_idx" ON "activity_events" USING btree ("project_id","seq") WHERE "activity_events"."outcome" <> ALL (ARRAY['published', 'retrying', 'resolved', 'connect_failed']::activity_outcome[]);--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_engagement_kinds" CHECK ("activity_events"."kind"::text NOT LIKE 'engagement_%' OR ("activity_events"."social_account_id" IS NOT NULL AND "activity_events"."provider_key" IS NOT NULL AND "activity_events"."post_target_id" IS NULL));--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_kind_outcome" CHECK ((kind::text = 'target_published' AND outcome::text = 'published') OR (kind::text = 'target_failed' AND outcome::text = 'failed') OR (kind::text = 'target_ambiguous' AND outcome::text = 'ambiguous') OR (kind::text = 'target_retry_scheduled' AND outcome::text = 'retrying') OR (kind::text = 'target_resolved' AND outcome::text = 'resolved') OR (kind::text = 'account_needs_reauth' AND outcome::text = 'needs_reauth') OR (kind::text = 'account_connect_failed' AND outcome::text = 'connect_failed') OR (kind::text = 'engagement_received' AND outcome::text = 'engagement') OR (kind::text = 'engagement_replied' AND outcome::text = 'published') OR (kind::text = 'engagement_ambiguous' AND outcome::text = 'ambiguous'));--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_kind_key" CHECK ("notification_preferences"."axis" <> 'kind' OR "notification_preferences"."switch_key" IN ('failed', 'ambiguous', 'needs_reauth', 'connect_failed', 'engagement'));