CREATE TYPE "public"."social_account_status" AS ENUM('active', 'needs_reauth');--> statement-breakpoint
CREATE TYPE "public"."publish_attempt_outcome" AS ENUM('continue', 'done', 'retryable_error', 'fatal_error', 'ambiguous', 'deferred', 'recovered_retry', 'recovered_ambiguous', 'stale_result', 'account_unavailable', 'did_not_complete', 'released', 'resolved_published', 'resolved_failed', 'retry_requested');--> statement-breakpoint
CREATE TYPE "public"."post_origin" AS ENUM('manual', 'generated', 'api');--> statement-breakpoint
CREATE TYPE "public"."post_review_state" AS ENUM('draft', 'needs_review', 'approved');--> statement-breakpoint
CREATE TYPE "public"."post_status" AS ENUM('draft', 'needs_review', 'approved', 'scheduled', 'publishing', 'published', 'partially_failed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."post_target_status" AS ENUM('draft', 'scheduled', 'publishing', 'published', 'failed', 'ambiguous', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."schedule_kind" AS ENUM('slot', 'explicit', 'now');--> statement-breakpoint
CREATE TABLE "posting_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"social_account_id" uuid NOT NULL,
	"weekday" smallint NOT NULL,
	"local_time" time(0) NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "posting_slots_account_time_uq" UNIQUE("social_account_id","weekday","local_time"),
	CONSTRAINT "posting_slots_weekday_range" CHECK ("posting_slots"."weekday" BETWEEN 1 AND 7)
);
--> statement-breakpoint
CREATE TABLE "social_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"provider_key" text NOT NULL,
	"display_name" text NOT NULL,
	"external_account_id" text NOT NULL,
	"credentials_encrypted" text,
	"credentials_expires_at" timestamp with time zone,
	"status" "social_account_status" DEFAULT 'active' NOT NULL,
	"last_error" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"publish_limit_count" integer,
	"publish_limit_window_seconds" integer,
	"refresh_lease_until" timestamp with time zone,
	"refresh_lease_owner" uuid,
	"last_refreshed_at" timestamp with time zone,
	"connected_by_user_id" uuid,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "social_accounts_limit_count_pos" CHECK ("social_accounts"."publish_limit_count" > 0),
	CONSTRAINT "social_accounts_limit_window_pos" CHECK ("social_accounts"."publish_limit_window_seconds" > 0),
	CONSTRAINT "social_accounts_limit_pair" CHECK (("social_accounts"."publish_limit_count" IS NULL) = ("social_accounts"."publish_limit_window_seconds" IS NULL)),
	CONSTRAINT "social_accounts_refresh_lease_pair" CHECK (("social_accounts"."refresh_lease_until" IS NULL) = ("social_accounts"."refresh_lease_owner" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "publish_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"post_target_id" uuid NOT NULL,
	"step" text NOT NULL,
	"outcome" "publish_attempt_outcome" NOT NULL,
	"request_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"response_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"duration_ms" integer,
	"tick_id" uuid,
	"actor_user_id" uuid,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"public_url" text NOT NULL,
	"mime_type" text NOT NULL,
	"width" integer,
	"height" integer,
	"byte_size" integer NOT NULL,
	"alt_text" text DEFAULT '' NOT NULL,
	"first_used_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_assets_storage_key_uq" UNIQUE("project_id","storage_key"),
	CONSTRAINT "media_assets_width_pos" CHECK ("media_assets"."width" > 0),
	CONSTRAINT "media_assets_height_pos" CHECK ("media_assets"."height" > 0),
	CONSTRAINT "media_assets_byte_size_pos" CHECK ("media_assets"."byte_size" > 0)
);
--> statement-breakpoint
CREATE TABLE "post_media" (
	"project_id" uuid NOT NULL,
	"post_id" uuid NOT NULL,
	"media_asset_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	CONSTRAINT "post_media_post_id_position_pk" PRIMARY KEY("post_id","position"),
	CONSTRAINT "post_media_post_asset_uq" UNIQUE("post_id","media_asset_id"),
	CONSTRAINT "post_media_position_nonneg" CHECK ("post_media"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "post_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"post_id" uuid NOT NULL,
	"social_account_id" uuid NOT NULL,
	"status" "post_target_status" DEFAULT 'draft' NOT NULL,
	"schedule_kind" "schedule_kind",
	"scheduled_at" timestamp with time zone,
	"slot_id" uuid,
	"slot_occurrence_at" timestamp with time zone,
	"override_text" text,
	"step_state" jsonb,
	"in_flight_step" text,
	"in_flight_may_publish" boolean,
	"first_step_at" timestamp with time zone,
	"publish_started_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"lease_until" timestamp with time zone,
	"lease_owner" uuid,
	"last_error" text,
	"external_id" text,
	"external_url" text,
	"published_at" timestamp with time zone,
	"resolved_by_user_id" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "post_targets_post_account_uq" UNIQUE("post_id","social_account_id"),
	CONSTRAINT "post_targets_occurrence_is_slot" CHECK ("post_targets"."slot_occurrence_at" IS NULL OR "post_targets"."schedule_kind" = 'slot'),
	CONSTRAINT "post_targets_lease_pair" CHECK (("post_targets"."lease_until" IS NULL) = ("post_targets"."lease_owner" IS NULL)),
	CONSTRAINT "post_targets_live_has_schedule" CHECK ("post_targets"."status" NOT IN ('scheduled','publishing') OR ("post_targets"."next_attempt_at" IS NOT NULL AND "post_targets"."scheduled_at" IS NOT NULL AND "post_targets"."schedule_kind" IS NOT NULL)),
	CONSTRAINT "post_targets_published_has_id" CHECK ("post_targets"."status" <> 'published' OR "post_targets"."external_id" IS NOT NULL OR "post_targets"."resolved_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"status" "post_status" DEFAULT 'draft' NOT NULL,
	"review_state" "post_review_state" DEFAULT 'draft' NOT NULL,
	"base_text" text DEFAULT '' NOT NULL,
	"origin" "post_origin" DEFAULT 'manual' NOT NULL,
	"generation_metadata" jsonb,
	"created_by_user_id" uuid,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduler_heartbeats" (
	"section" text PRIMARY KEY NOT NULL,
	"last_success_at" timestamp with time zone NOT NULL,
	"last_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "posting_slots" ADD CONSTRAINT "posting_slots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posting_slots" ADD CONSTRAINT "posting_slots_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_connected_by_user_id_user_id_fk" FOREIGN KEY ("connected_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_attempts" ADD CONSTRAINT "publish_attempts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_attempts" ADD CONSTRAINT "publish_attempts_post_target_id_post_targets_id_fk" FOREIGN KEY ("post_target_id") REFERENCES "public"."post_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_attempts" ADD CONSTRAINT "publish_attempts_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_media" ADD CONSTRAINT "post_media_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_media" ADD CONSTRAINT "post_media_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_media" ADD CONSTRAINT "post_media_media_asset_id_media_assets_id_fk" FOREIGN KEY ("media_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_targets" ADD CONSTRAINT "post_targets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_targets" ADD CONSTRAINT "post_targets_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_targets" ADD CONSTRAINT "post_targets_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_targets" ADD CONSTRAINT "post_targets_slot_id_posting_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."posting_slots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_targets" ADD CONSTRAINT "post_targets_resolved_by_user_id_user_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "posting_slots_project_account_idx" ON "posting_slots" USING btree ("project_id","social_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "social_accounts_external_uq" ON "social_accounts" USING btree ("project_id","provider_key","external_account_id") WHERE "social_accounts"."removed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "social_accounts_project_idx" ON "social_accounts" USING btree ("project_id") WHERE "social_accounts"."removed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "social_accounts_expiry_idx" ON "social_accounts" USING btree ("credentials_expires_at") WHERE "social_accounts"."removed_at" IS NULL AND "social_accounts"."status" = 'active' AND "social_accounts"."credentials_expires_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "publish_attempts_target_created_idx" ON "publish_attempts" USING btree ("project_id","post_target_id","created_at");--> statement-breakpoint
CREATE INDEX "media_assets_first_used_idx" ON "media_assets" USING btree ("project_id","first_used_at");--> statement-breakpoint
CREATE UNIQUE INDEX "post_targets_occurrence_uq" ON "post_targets" USING btree ("social_account_id","slot_occurrence_at") WHERE "post_targets"."slot_occurrence_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "post_targets_due_idx" ON "post_targets" USING btree ("next_attempt_at") WHERE "post_targets"."status" IN ('scheduled','publishing');--> statement-breakpoint
CREATE INDEX "post_targets_started_idx" ON "post_targets" USING btree ("social_account_id","publish_started_at") WHERE "post_targets"."publish_started_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "post_targets_account_sched_idx" ON "post_targets" USING btree ("social_account_id","scheduled_at") WHERE "post_targets"."status" = 'scheduled';--> statement-breakpoint
CREATE INDEX "post_targets_project_post_idx" ON "post_targets" USING btree ("project_id","post_id");--> statement-breakpoint
CREATE INDEX "posts_project_status_idx" ON "posts" USING btree ("project_id","status") WHERE "posts"."deleted_at" IS NULL;