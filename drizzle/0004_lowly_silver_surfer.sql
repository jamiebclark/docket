CREATE TYPE "public"."generation_mode" AS ENUM('single', 'series_plan', 'series_post', 'regenerate');--> statement-breakpoint
CREATE TYPE "public"."llm_failure_kind" AS ENUM('invalid_output', 'refused', 'incomplete', 'timeout', 'rate_limited', 'unavailable', 'auth', 'bad_request');--> statement-breakpoint
ALTER TYPE "public"."post_review_state" ADD VALUE 'rejected';--> statement-breakpoint
ALTER TYPE "public"."post_status" ADD VALUE 'rejected';--> statement-breakpoint
CREATE TABLE "generation_failures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"mode" "generation_mode" NOT NULL,
	"series_id" uuid,
	"series_position" smallint,
	"post_id" uuid,
	"inputs" jsonb NOT NULL,
	"kind" "llm_failure_kind" NOT NULL,
	"message" text NOT NULL,
	"attempts" jsonb NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"requested_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "generation_failures_series_pair" CHECK (("generation_failures"."series_id" IS NULL) = ("generation_failures"."series_position" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "generation_series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"brief" text NOT NULL,
	"plan" jsonb NOT NULL,
	"request" jsonb NOT NULL,
	"planned_count" smallint NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "generation_series_project_id_uq" UNIQUE("project_id","id"),
	CONSTRAINT "generation_series_planned_count_range" CHECK ("generation_series"."planned_count" BETWEEN 2 AND 10)
);
--> statement-breakpoint
CREATE TABLE "voice_profile_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"content" jsonb NOT NULL,
	"author_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "voice_profile_versions_profile_version_uq" UNIQUE("profile_id","version"),
	CONSTRAINT "voice_profile_versions_project_id_uq" UNIQUE("project_id","id"),
	CONSTRAINT "voice_profile_versions_version_pos" CHECK ("voice_profile_versions"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "voice_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "voice_profiles_project_id_uq" UNIQUE("project_id","id"),
	CONSTRAINT "voice_profiles_current_version_pos" CHECK ("voice_profiles"."current_version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "default_voice_profile_id" uuid;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "generation_request_id" uuid;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "scheduling_policy" "scheduling_policy";--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "series_id" uuid;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "series_position" smallint;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "reviewed_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "rejection_reason" text;--> statement-breakpoint
ALTER TABLE "generation_failures" ADD CONSTRAINT "generation_failures_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_failures" ADD CONSTRAINT "generation_failures_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_failures" ADD CONSTRAINT "generation_failures_requested_by_user_id_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_failures" ADD CONSTRAINT "generation_failures_series_fk" FOREIGN KEY ("project_id","series_id") REFERENCES "public"."generation_series"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_series" ADD CONSTRAINT "generation_series_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_series" ADD CONSTRAINT "generation_series_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_profile_versions" ADD CONSTRAINT "voice_profile_versions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_profile_versions" ADD CONSTRAINT "voice_profile_versions_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_profile_versions" ADD CONSTRAINT "voice_profile_versions_profile_fk" FOREIGN KEY ("project_id","profile_id") REFERENCES "public"."voice_profiles"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_profiles" ADD CONSTRAINT "voice_profiles_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_profiles" ADD CONSTRAINT "voice_profiles_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "generation_failures_project_created_idx" ON "generation_failures" USING btree ("project_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "voice_profiles_project_name_uq" ON "voice_profiles" USING btree ("project_id",lower("name")) WHERE "voice_profiles"."archived_at" IS NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_default_voice_profile_fk" FOREIGN KEY ("id","default_voice_profile_id") REFERENCES "public"."voice_profiles"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_reviewed_by_user_id_user_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_series_fk" FOREIGN KEY ("project_id","series_id") REFERENCES "public"."generation_series"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "posts_generation_request_uq" ON "posts" USING btree ("project_id","generation_request_id") WHERE "posts"."generation_request_id" IS NOT NULL AND "posts"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "posts_series_position_uq" ON "posts" USING btree ("series_id","series_position") WHERE "posts"."series_id" IS NOT NULL AND "posts"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "posts_review_queue_idx" ON "posts" USING btree ("project_id","review_state","created_at" DESC NULLS LAST) WHERE "posts"."deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_series_pair" CHECK (("posts"."series_id" IS NULL) = ("posts"."series_position" IS NULL));