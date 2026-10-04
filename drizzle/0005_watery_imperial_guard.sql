CREATE TYPE "public"."generation_job_item_error" AS ENUM('timeout', 'rate_limited', 'unavailable', 'internal', 'interrupted', 'invalid_output', 'refused', 'incomplete', 'auth', 'bad_request', 'image_deleted', 'image_unavailable', 'no_targets');--> statement-breakpoint
CREATE TYPE "public"."generation_job_item_status" AS ENUM('queued', 'running', 'done', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."generation_job_status" AS ENUM('queued', 'running', 'completed', 'completed_with_failures', 'cancelled');--> statement-breakpoint
CREATE TABLE "generation_job_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"label" text NOT NULL,
	"payload" jsonb NOT NULL,
	"media_asset_id" uuid,
	"status" "generation_job_item_status" DEFAULT 'queued' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" uuid,
	"lease_until" timestamp with time zone,
	"pending_retry" jsonb,
	"last_error_kind" "generation_job_item_error",
	"last_error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "generation_job_items_project_id_uq" UNIQUE("project_id","id"),
	CONSTRAINT "generation_job_items_job_position_uq" UNIQUE("job_id","position"),
	CONSTRAINT "generation_job_items_position_nonneg" CHECK ("generation_job_items"."position" >= 0),
	CONSTRAINT "generation_job_items_label_len" CHECK (char_length("generation_job_items"."label") <= 200),
	CONSTRAINT "generation_job_items_last_error_len" CHECK ("generation_job_items"."last_error" IS NULL OR char_length("generation_job_items"."last_error") <= 500),
	CONSTRAINT "generation_job_items_lease_pair" CHECK (("generation_job_items"."lease_until" IS NULL) = ("generation_job_items"."lease_owner" IS NULL)),
	CONSTRAINT "generation_job_items_running_leased" CHECK (("generation_job_items"."status" = 'running') = ("generation_job_items"."lease_owner" IS NOT NULL)),
	CONSTRAINT "generation_job_items_pending_retry_state" CHECK ("generation_job_items"."pending_retry" IS NULL OR "generation_job_items"."status" IN ('queued','running'))
);
--> statement-breakpoint
CREATE TABLE "generation_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"source_kind" text NOT NULL,
	"source_summary" text NOT NULL,
	"source_meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"voice_profile_id" uuid NOT NULL,
	"voice_profile_version_id" uuid NOT NULL,
	"template" text NOT NULL,
	"template_fields" text[] NOT NULL,
	"target_account_ids" uuid[] NOT NULL,
	"requested_approval" "approval_policy",
	"requested_scheduling" "scheduling_policy",
	"approval_policy" "approval_policy" NOT NULL,
	"scheduling_policy" "scheduling_policy" NOT NULL,
	"status" "generation_job_status" DEFAULT 'queued' NOT NULL,
	"item_count" integer NOT NULL,
	"created_by_user_id" uuid,
	"cancelled_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"last_claimed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "generation_jobs_project_id_uq" UNIQUE("project_id","id"),
	CONSTRAINT "generation_jobs_source_kind_len" CHECK (char_length("generation_jobs"."source_kind") BETWEEN 1 AND 32),
	CONSTRAINT "generation_jobs_source_summary_len" CHECK (char_length("generation_jobs"."source_summary") BETWEEN 1 AND 200),
	CONSTRAINT "generation_jobs_template_len" CHECK (char_length("generation_jobs"."template") BETWEEN 1 AND 2000),
	CONSTRAINT "generation_jobs_targets_card" CHECK (cardinality("generation_jobs"."target_account_ids") BETWEEN 1 AND 50),
	CONSTRAINT "generation_jobs_item_count_range" CHECK ("generation_jobs"."item_count" BETWEEN 1 AND 500),
	CONSTRAINT "generation_jobs_cancelled_pair" CHECK (("generation_jobs"."status" = 'cancelled') = ("generation_jobs"."cancelled_at" IS NOT NULL)),
	CONSTRAINT "generation_jobs_finished_set" CHECK ("generation_jobs"."status" NOT IN ('completed','completed_with_failures') OR "generation_jobs"."finished_at" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "generation_job_item_id" uuid;--> statement-breakpoint
ALTER TABLE "generation_job_items" ADD CONSTRAINT "generation_job_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_job_items" ADD CONSTRAINT "generation_job_items_media_asset_id_media_assets_id_fk" FOREIGN KEY ("media_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_job_items" ADD CONSTRAINT "generation_job_items_job_fk" FOREIGN KEY ("project_id","job_id") REFERENCES "public"."generation_jobs"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_cancelled_by_user_id_user_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_voice_profile_fk" FOREIGN KEY ("project_id","voice_profile_id") REFERENCES "public"."voice_profiles"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_voice_version_fk" FOREIGN KEY ("project_id","voice_profile_version_id") REFERENCES "public"."voice_profile_versions"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "generation_job_items_active_media_uq" ON "generation_job_items" USING btree ("project_id","media_asset_id") WHERE "generation_job_items"."media_asset_id" IS NOT NULL AND "generation_job_items"."status" IN ('queued','running','failed');--> statement-breakpoint
CREATE INDEX "generation_job_items_due_idx" ON "generation_job_items" USING btree ("job_id","position") WHERE "generation_job_items"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "generation_job_items_recovery_idx" ON "generation_job_items" USING btree ("lease_until") WHERE "generation_job_items"."status" = 'running';--> statement-breakpoint
CREATE INDEX "generation_job_items_counts_idx" ON "generation_job_items" USING btree ("project_id","job_id","status");--> statement-breakpoint
CREATE INDEX "generation_jobs_project_created_idx" ON "generation_jobs" USING btree ("project_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "generation_jobs_claim_idx" ON "generation_jobs" USING btree ("last_claimed_at" NULLS FIRST,"created_at") WHERE "generation_jobs"."status" IN ('queued','running');--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_generation_job_item_fk" FOREIGN KEY ("project_id","generation_job_item_id") REFERENCES "public"."generation_job_items"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "posts_generation_job_item_uq" ON "posts" USING btree ("generation_job_item_id") WHERE "posts"."generation_job_item_id" IS NOT NULL AND "posts"."deleted_at" IS NULL;