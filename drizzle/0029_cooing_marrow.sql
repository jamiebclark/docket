CREATE TYPE "public"."standing_series_block_reason" AS ENUM('voice_profile_missing', 'no_usable_target');--> statement-breakpoint
CREATE TYPE "public"."standing_series_media_source" AS ENUM('none', 'pool', 'generate');--> statement-breakpoint
CREATE TYPE "public"."standing_series_outcome" AS ENUM('produced_all', 'produced_some', 'produced_none', 'incomplete');--> statement-breakpoint
CREATE TYPE "public"."standing_series_pause_reason" AS ENUM('no_output');--> statement-breakpoint
CREATE TYPE "public"."standing_series_period" AS ENUM('day', 'week', 'month');--> statement-breakpoint
CREATE TYPE "public"."standing_series_position_status" AS ENUM('queued', 'running', 'produced', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."standing_series_skip_reason" AS ENUM('pool_exhausted', 'image_generation_not_configured', 'image_generation_failed', 'media_unusable', 'media_storage_not_configured', 'series_not_runnable');--> statement-breakpoint
ALTER TYPE "public"."membership_action" ADD VALUE 'standing_series_create';--> statement-breakpoint
ALTER TYPE "public"."membership_action" ADD VALUE 'standing_series_update';--> statement-breakpoint
ALTER TYPE "public"."membership_action" ADD VALUE 'standing_series_pause';--> statement-breakpoint
ALTER TYPE "public"."membership_action" ADD VALUE 'standing_series_resume';--> statement-breakpoint
ALTER TYPE "public"."membership_action" ADD VALUE 'standing_series_delete';--> statement-breakpoint
ALTER TYPE "public"."generation_mode" ADD VALUE 'standing_series_plan';--> statement-breakpoint
ALTER TYPE "public"."generation_mode" ADD VALUE 'standing_series_post';--> statement-breakpoint
ALTER TYPE "public"."llm_usage_purpose" ADD VALUE 'generate.standing_series_plan' BEFORE 'voice.try';--> statement-breakpoint
ALTER TYPE "public"."llm_usage_purpose" ADD VALUE 'generate.standing_series_post' BEFORE 'voice.try';--> statement-breakpoint
CREATE TABLE "standing_series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"brief" text NOT NULL,
	"template" text NOT NULL,
	"template_fields" text[] DEFAULT '{}'::text[] NOT NULL,
	"voice_profile_id" uuid NOT NULL,
	"target_account_ids" uuid[] NOT NULL,
	"cadence_count" smallint NOT NULL,
	"cadence_period" "standing_series_period" NOT NULL,
	"media_source" "standing_series_media_source" NOT NULL,
	"media_pool_tag" text,
	"image_prompt" text,
	"requested_approval" "approval_policy",
	"requested_scheduling" "scheduling_policy",
	"approval_policy" "approval_policy" NOT NULL,
	"scheduling_policy" "scheduling_policy" NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"auto_paused_reason" "standing_series_pause_reason",
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone NOT NULL,
	"lease_owner" uuid,
	"lease_until" timestamp with time zone,
	"last_claimed_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "standing_series_project_id_uq" UNIQUE("project_id","id"),
	CONSTRAINT "standing_series_name_len" CHECK (char_length("standing_series"."name") BETWEEN 1 AND 100 AND btrim("standing_series"."name") = "standing_series"."name"),
	CONSTRAINT "standing_series_brief_len" CHECK (char_length("standing_series"."brief") BETWEEN 1 AND 2000),
	CONSTRAINT "standing_series_template_len" CHECK (char_length("standing_series"."template") BETWEEN 1 AND 2000),
	CONSTRAINT "standing_series_targets_card" CHECK (cardinality("standing_series"."target_account_ids") BETWEEN 1 AND 50),
	CONSTRAINT "standing_series_cadence_count_range" CHECK ("standing_series"."cadence_count" BETWEEN 1 AND 10),
	CONSTRAINT "standing_series_pool_tag_only_for_pool" CHECK ("standing_series"."media_pool_tag" IS NULL OR "standing_series"."media_source" = 'pool'),
	CONSTRAINT "standing_series_image_prompt_pair" CHECK (("standing_series"."media_source" = 'generate') = ("standing_series"."image_prompt" IS NOT NULL)),
	CONSTRAINT "standing_series_image_prompt_len" CHECK ("standing_series"."image_prompt" IS NULL OR char_length("standing_series"."image_prompt") BETWEEN 1 AND 1000),
	CONSTRAINT "standing_series_lease_pair" CHECK (("standing_series"."lease_until" IS NULL) = ("standing_series"."lease_owner" IS NULL)),
	CONSTRAINT "standing_series_auto_pause_implies_disabled" CHECK ("standing_series"."auto_paused_reason" IS NULL OR "standing_series"."enabled" = false)
);
--> statement-breakpoint
CREATE TABLE "standing_series_positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"status" "standing_series_position_status" DEFAULT 'queued' NOT NULL,
	"media_asset_id" uuid,
	"attempt_count" smallint DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pending_retry" jsonb,
	"last_error_kind" "generation_job_item_error",
	"last_error" text,
	"skip_reason" "standing_series_skip_reason",
	"skip_account_id" uuid,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "standing_series_positions_project_id_uq" UNIQUE("project_id","id"),
	CONSTRAINT "standing_series_positions_run_position_uq" UNIQUE("run_id","position"),
	CONSTRAINT "standing_series_positions_position_nonneg" CHECK ("standing_series_positions"."position" >= 0),
	CONSTRAINT "standing_series_positions_last_error_len" CHECK ("standing_series_positions"."last_error" IS NULL OR char_length("standing_series_positions"."last_error") <= 500),
	CONSTRAINT "standing_series_positions_skip_pair" CHECK (("standing_series_positions"."status" = 'skipped') = ("standing_series_positions"."skip_reason" IS NOT NULL)),
	CONSTRAINT "standing_series_positions_skip_account_needs_reason" CHECK ("standing_series_positions"."skip_account_id" IS NULL OR "standing_series_positions"."skip_reason" IS NOT NULL),
	CONSTRAINT "standing_series_positions_failed_has_kind" CHECK ("standing_series_positions"."status" <> 'failed' OR "standing_series_positions"."last_error_kind" IS NOT NULL),
	CONSTRAINT "standing_series_positions_pending_retry_state" CHECK ("standing_series_positions"."pending_retry" IS NULL OR "standing_series_positions"."status" IN ('queued','running'))
);
--> statement-breakpoint
CREATE TABLE "standing_series_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"series_id" uuid NOT NULL,
	"period" "standing_series_period" NOT NULL,
	"period_start" date NOT NULL,
	"period_start_at" timestamp with time zone NOT NULL,
	"requested_count" smallint NOT NULL,
	"config" jsonb NOT NULL,
	"plan" jsonb,
	"plan_attempt_count" smallint DEFAULT 0 NOT NULL,
	"plan_next_attempt_at" timestamp with time zone,
	"missed_periods" smallint DEFAULT 0 NOT NULL,
	"dropped_account_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"blocked_reason" "standing_series_block_reason",
	"outcome" "standing_series_outcome",
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "standing_series_runs_project_id_uq" UNIQUE("project_id","id"),
	CONSTRAINT "standing_series_runs_period_uq" UNIQUE("series_id","period","period_start"),
	CONSTRAINT "standing_series_runs_requested_count_range" CHECK ("standing_series_runs"."requested_count" BETWEEN 1 AND 10),
	CONSTRAINT "standing_series_runs_closed_pair" CHECK (("standing_series_runs"."closed_at" IS NULL) = ("standing_series_runs"."outcome" IS NULL)),
	CONSTRAINT "standing_series_runs_single_post_has_no_plan" CHECK ("standing_series_runs"."requested_count" > 1 OR "standing_series_runs"."plan" IS NULL),
	CONSTRAINT "standing_series_runs_missed_nonneg" CHECK ("standing_series_runs"."missed_periods" >= 0),
	CONSTRAINT "standing_series_runs_plan_attempts_nonneg" CHECK ("standing_series_runs"."plan_attempt_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "generation_failures" ADD COLUMN "standing_series_run_id" uuid;--> statement-breakpoint
ALTER TABLE "generation_failures" ADD COLUMN "standing_series_position" smallint;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "standing_series_position_id" uuid;--> statement-breakpoint
ALTER TABLE "standing_series" ADD CONSTRAINT "standing_series_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standing_series" ADD CONSTRAINT "standing_series_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standing_series" ADD CONSTRAINT "standing_series_voice_profile_fk" FOREIGN KEY ("project_id","voice_profile_id") REFERENCES "public"."voice_profiles"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standing_series_positions" ADD CONSTRAINT "standing_series_positions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standing_series_positions" ADD CONSTRAINT "standing_series_positions_media_asset_id_media_assets_id_fk" FOREIGN KEY ("media_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standing_series_positions" ADD CONSTRAINT "standing_series_positions_run_fk" FOREIGN KEY ("project_id","run_id") REFERENCES "public"."standing_series_runs"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standing_series_runs" ADD CONSTRAINT "standing_series_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standing_series_runs" ADD CONSTRAINT "standing_series_runs_series_fk" FOREIGN KEY ("project_id","series_id") REFERENCES "public"."standing_series"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "standing_series_project_name_uq" ON "standing_series" USING btree ("project_id",lower("name"));--> statement-breakpoint
CREATE INDEX "standing_series_claim_idx" ON "standing_series" USING btree ("next_run_at","last_claimed_at" NULLS FIRST,"id") WHERE "standing_series"."enabled";--> statement-breakpoint
CREATE INDEX "standing_series_project_name_idx" ON "standing_series" USING btree ("project_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "standing_series_positions_active_media_uq" ON "standing_series_positions" USING btree ("project_id","media_asset_id") WHERE "standing_series_positions"."media_asset_id" IS NOT NULL AND "standing_series_positions"."status" IN ('queued','running');--> statement-breakpoint
CREATE INDEX "standing_series_positions_due_idx" ON "standing_series_positions" USING btree ("run_id","position") WHERE "standing_series_positions"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "standing_series_positions_counts_idx" ON "standing_series_positions" USING btree ("project_id","run_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "standing_series_runs_open_uq" ON "standing_series_runs" USING btree ("series_id") WHERE "standing_series_runs"."closed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "standing_series_runs_series_recent_idx" ON "standing_series_runs" USING btree ("project_id","series_id","opened_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "standing_series_runs_closed_idx" ON "standing_series_runs" USING btree ("closed_at") WHERE "standing_series_runs"."closed_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "generation_failures" ADD CONSTRAINT "generation_failures_standing_series_run_fk" FOREIGN KEY ("project_id","standing_series_run_id") REFERENCES "public"."standing_series_runs"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_standing_series_position_fk" FOREIGN KEY ("project_id","standing_series_position_id") REFERENCES "public"."standing_series_positions"("project_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "generation_failures_project_run_idx" ON "generation_failures" USING btree ("project_id","standing_series_run_id") WHERE "generation_failures"."standing_series_run_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "posts_standing_series_position_uq" ON "posts" USING btree ("standing_series_position_id") WHERE "posts"."standing_series_position_id" IS NOT NULL AND "posts"."deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "generation_failures" ADD CONSTRAINT "generation_failures_standing_mode_pair" CHECK (("generation_failures"."mode" NOT IN ('single','series_plan','series_post','regenerate')) = ("generation_failures"."standing_series_run_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "generation_failures" ADD CONSTRAINT "generation_failures_standing_position_needs_run" CHECK ("generation_failures"."standing_series_position" IS NULL OR "generation_failures"."standing_series_run_id" IS NOT NULL);