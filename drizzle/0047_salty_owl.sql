CREATE TYPE "public"."metric_kind" AS ENUM('cumulative', 'windowed', 'unknown');--> statement-breakpoint
CREATE TABLE "account_metric_rollups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"social_account_id" uuid NOT NULL,
	"provider_key" text NOT NULL,
	"metric_key" text NOT NULL,
	"captured_day" date NOT NULL,
	"value" double precision NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"kind" "metric_kind" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_metric_rollups_subject_uq" UNIQUE("project_id","social_account_id","metric_key","captured_day"),
	CONSTRAINT "account_metric_rollups_provider_key_len" CHECK (char_length("account_metric_rollups"."provider_key") BETWEEN 1 AND 50),
	CONSTRAINT "account_metric_rollups_metric_key_len" CHECK (char_length("account_metric_rollups"."metric_key") BETWEEN 1 AND 100),
	CONSTRAINT "account_metric_rollups_captured_at_ms" CHECK ("account_metric_rollups"."captured_at" = date_trunc('milliseconds', "account_metric_rollups"."captured_at"))
);
--> statement-breakpoint
CREATE TABLE "post_metric_rollups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"post_target_id" uuid NOT NULL,
	"social_account_id" uuid NOT NULL,
	"provider_key" text NOT NULL,
	"metric_key" text NOT NULL,
	"captured_day" date NOT NULL,
	"value" double precision NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"kind" "metric_kind" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "post_metric_rollups_subject_uq" UNIQUE("project_id","post_target_id","metric_key","captured_day"),
	CONSTRAINT "post_metric_rollups_provider_key_len" CHECK (char_length("post_metric_rollups"."provider_key") BETWEEN 1 AND 50),
	CONSTRAINT "post_metric_rollups_metric_key_len" CHECK (char_length("post_metric_rollups"."metric_key") BETWEEN 1 AND 100),
	CONSTRAINT "post_metric_rollups_captured_at_ms" CHECK ("post_metric_rollups"."captured_at" = date_trunc('milliseconds', "post_metric_rollups"."captured_at"))
);
--> statement-breakpoint
CREATE TABLE "target_first_engagement" (
	"post_target_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"social_account_id" uuid NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"exact_first_at" timestamp with time zone,
	"bound_before_at" timestamp with time zone,
	"bound_after_at" timestamp with time zone,
	"scanned_through" timestamp with time zone,
	"first_recorded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "target_first_engagement_exact_after_published" CHECK ("target_first_engagement"."exact_first_at" IS NULL OR "target_first_engagement"."exact_first_at" >= "target_first_engagement"."published_at"),
	CONSTRAINT "target_first_engagement_bound_before_after_published" CHECK ("target_first_engagement"."bound_before_at" IS NULL OR "target_first_engagement"."bound_before_at" > "target_first_engagement"."published_at"),
	CONSTRAINT "target_first_engagement_bound_after_needs_before" CHECK ("target_first_engagement"."bound_after_at" IS NULL OR "target_first_engagement"."bound_before_at" IS NOT NULL),
	CONSTRAINT "target_first_engagement_bound_after_before_before" CHECK ("target_first_engagement"."bound_after_at" IS NULL OR "target_first_engagement"."bound_after_at" < "target_first_engagement"."bound_before_at"),
	CONSTRAINT "target_first_engagement_bound_after_after_published" CHECK ("target_first_engagement"."bound_after_at" IS NULL OR "target_first_engagement"."bound_after_at" >= "target_first_engagement"."published_at"),
	CONSTRAINT "target_first_engagement_first_recorded_pair" CHECK (("target_first_engagement"."first_recorded_at" IS NULL) = ("target_first_engagement"."exact_first_at" IS NULL AND "target_first_engagement"."bound_before_at" IS NULL)),
	CONSTRAINT "target_first_engagement_published_at_ms" CHECK ("target_first_engagement"."published_at" = date_trunc('milliseconds', "target_first_engagement"."published_at")),
	CONSTRAINT "target_first_engagement_exact_first_at_ms" CHECK ("target_first_engagement"."exact_first_at" IS NULL OR "target_first_engagement"."exact_first_at" = date_trunc('milliseconds', "target_first_engagement"."exact_first_at")),
	CONSTRAINT "target_first_engagement_bound_before_at_ms" CHECK ("target_first_engagement"."bound_before_at" IS NULL OR "target_first_engagement"."bound_before_at" = date_trunc('milliseconds', "target_first_engagement"."bound_before_at")),
	CONSTRAINT "target_first_engagement_bound_after_at_ms" CHECK ("target_first_engagement"."bound_after_at" IS NULL OR "target_first_engagement"."bound_after_at" = date_trunc('milliseconds', "target_first_engagement"."bound_after_at")),
	CONSTRAINT "target_first_engagement_scanned_through_ms" CHECK ("target_first_engagement"."scanned_through" IS NULL OR "target_first_engagement"."scanned_through" = date_trunc('milliseconds', "target_first_engagement"."scanned_through")),
	CONSTRAINT "target_first_engagement_first_recorded_at_ms" CHECK ("target_first_engagement"."first_recorded_at" IS NULL OR "target_first_engagement"."first_recorded_at" = date_trunc('milliseconds', "target_first_engagement"."first_recorded_at"))
);
--> statement-breakpoint
ALTER TABLE "account_metric_rollups" ADD CONSTRAINT "account_metric_rollups_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_metric_rollups" ADD CONSTRAINT "account_metric_rollups_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_metric_rollups" ADD CONSTRAINT "post_metric_rollups_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_metric_rollups" ADD CONSTRAINT "post_metric_rollups_post_target_id_post_targets_id_fk" FOREIGN KEY ("post_target_id") REFERENCES "public"."post_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_metric_rollups" ADD CONSTRAINT "post_metric_rollups_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "target_first_engagement" ADD CONSTRAINT "target_first_engagement_post_target_id_post_targets_id_fk" FOREIGN KEY ("post_target_id") REFERENCES "public"."post_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "target_first_engagement" ADD CONSTRAINT "target_first_engagement_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "target_first_engagement" ADD CONSTRAINT "target_first_engagement_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_metric_rollups_range_idx" ON "account_metric_rollups" USING btree ("project_id","social_account_id","captured_day");--> statement-breakpoint
CREATE INDEX "post_metric_rollups_latest_idx" ON "post_metric_rollups" USING btree ("project_id","post_target_id","captured_day" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "post_metric_rollups_account_range_idx" ON "post_metric_rollups" USING btree ("project_id","social_account_id","captured_day");--> statement-breakpoint
CREATE INDEX "target_first_engagement_account_idx" ON "target_first_engagement" USING btree ("project_id","social_account_id");