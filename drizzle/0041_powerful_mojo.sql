CREATE TABLE "account_metric_poll_states" (
	"social_account_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"next_poll_at" timestamp with time zone,
	"poll_lease_until" timestamp with time zone,
	"poll_lease_owner" uuid,
	"last_polled_at" timestamp with time zone,
	"last_captured_at" timestamp with time zone,
	"consecutive_failures" smallint DEFAULT 0 NOT NULL,
	"last_error" text,
	"failing_since" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_metric_poll_states_lease_pair" CHECK (("account_metric_poll_states"."poll_lease_until" IS NULL) = ("account_metric_poll_states"."poll_lease_owner" IS NULL)),
	CONSTRAINT "account_metric_poll_states_failures_nonneg" CHECK ("account_metric_poll_states"."consecutive_failures" >= 0),
	CONSTRAINT "account_metric_poll_states_failing_pair" CHECK (("account_metric_poll_states"."consecutive_failures" = 0) = ("account_metric_poll_states"."failing_since" IS NULL)),
	CONSTRAINT "account_metric_poll_states_last_error_len" CHECK ("account_metric_poll_states"."last_error" IS NULL OR char_length("account_metric_poll_states"."last_error") <= 500)
);
--> statement-breakpoint
CREATE TABLE "account_metric_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"social_account_id" uuid NOT NULL,
	"provider_key" text NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_metric_snapshots_subject_uq" UNIQUE("project_id","social_account_id","captured_at"),
	CONSTRAINT "account_metric_snapshots_captured_at_ms" CHECK ("account_metric_snapshots"."captured_at" = date_trunc('milliseconds', "account_metric_snapshots"."captured_at")),
	CONSTRAINT "account_metric_snapshots_metrics_size" CHECK (octet_length("account_metric_snapshots"."metrics"::text) <= 2000),
	CONSTRAINT "account_metric_snapshots_metrics_object" CHECK (jsonb_typeof("account_metric_snapshots"."metrics") = 'object'),
	CONSTRAINT "account_metric_snapshots_provider_key_len" CHECK (char_length("account_metric_snapshots"."provider_key") BETWEEN 1 AND 50)
);
--> statement-breakpoint
CREATE TABLE "post_metric_poll_states" (
	"post_target_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"social_account_id" uuid NOT NULL,
	"next_poll_at" timestamp with time zone,
	"poll_lease_until" timestamp with time zone,
	"poll_lease_owner" uuid,
	"last_polled_at" timestamp with time zone,
	"last_captured_at" timestamp with time zone,
	"consecutive_failures" smallint DEFAULT 0 NOT NULL,
	"last_error" text,
	"failing_since" timestamp with time zone,
	"frozen_at" timestamp with time zone,
	"frozen_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "post_metric_poll_states_lease_pair" CHECK (("post_metric_poll_states"."poll_lease_until" IS NULL) = ("post_metric_poll_states"."poll_lease_owner" IS NULL)),
	CONSTRAINT "post_metric_poll_states_failures_nonneg" CHECK ("post_metric_poll_states"."consecutive_failures" >= 0),
	CONSTRAINT "post_metric_poll_states_frozen_pair" CHECK (("post_metric_poll_states"."frozen_at" IS NULL) = ("post_metric_poll_states"."frozen_reason" IS NULL)),
	CONSTRAINT "post_metric_poll_states_frozen_reason_enum" CHECK ("post_metric_poll_states"."frozen_reason" IS NULL OR "post_metric_poll_states"."frozen_reason" IN ('settled', 'gone')),
	CONSTRAINT "post_metric_poll_states_frozen_has_no_next" CHECK ("post_metric_poll_states"."frozen_at" IS NULL OR "post_metric_poll_states"."next_poll_at" IS NULL),
	CONSTRAINT "post_metric_poll_states_failing_pair" CHECK (("post_metric_poll_states"."consecutive_failures" = 0) = ("post_metric_poll_states"."failing_since" IS NULL)),
	CONSTRAINT "post_metric_poll_states_last_error_len" CHECK ("post_metric_poll_states"."last_error" IS NULL OR char_length("post_metric_poll_states"."last_error") <= 500)
);
--> statement-breakpoint
CREATE TABLE "post_metric_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"post_target_id" uuid NOT NULL,
	"social_account_id" uuid NOT NULL,
	"provider_key" text NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "post_metric_snapshots_subject_uq" UNIQUE("project_id","post_target_id","captured_at"),
	CONSTRAINT "post_metric_snapshots_captured_at_ms" CHECK ("post_metric_snapshots"."captured_at" = date_trunc('milliseconds', "post_metric_snapshots"."captured_at")),
	CONSTRAINT "post_metric_snapshots_metrics_size" CHECK (octet_length("post_metric_snapshots"."metrics"::text) <= 2000),
	CONSTRAINT "post_metric_snapshots_metrics_object" CHECK (jsonb_typeof("post_metric_snapshots"."metrics") = 'object'),
	CONSTRAINT "post_metric_snapshots_provider_key_len" CHECK (char_length("post_metric_snapshots"."provider_key") BETWEEN 1 AND 50)
);
--> statement-breakpoint
ALTER TABLE "account_metric_poll_states" ADD CONSTRAINT "account_metric_poll_states_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_metric_poll_states" ADD CONSTRAINT "account_metric_poll_states_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_metric_snapshots" ADD CONSTRAINT "account_metric_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_metric_snapshots" ADD CONSTRAINT "account_metric_snapshots_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_metric_poll_states" ADD CONSTRAINT "post_metric_poll_states_post_target_id_post_targets_id_fk" FOREIGN KEY ("post_target_id") REFERENCES "public"."post_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_metric_poll_states" ADD CONSTRAINT "post_metric_poll_states_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_metric_poll_states" ADD CONSTRAINT "post_metric_poll_states_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_metric_snapshots" ADD CONSTRAINT "post_metric_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_metric_snapshots" ADD CONSTRAINT "post_metric_snapshots_post_target_id_post_targets_id_fk" FOREIGN KEY ("post_target_id") REFERENCES "public"."post_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_metric_snapshots" ADD CONSTRAINT "post_metric_snapshots_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_metric_poll_states_claim_idx" ON "account_metric_poll_states" USING btree ("next_poll_at","social_account_id") WHERE "account_metric_poll_states"."poll_lease_until" IS NULL AND "account_metric_poll_states"."next_poll_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "account_metric_snapshots_latest_idx" ON "account_metric_snapshots" USING btree ("project_id","social_account_id","captured_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "account_metric_snapshots_window_idx" ON "account_metric_snapshots" USING btree ("social_account_id","captured_at");--> statement-breakpoint
CREATE INDEX "account_metric_snapshots_captured_idx" ON "account_metric_snapshots" USING btree ("captured_at");--> statement-breakpoint
CREATE INDEX "post_metric_poll_states_claim_idx" ON "post_metric_poll_states" USING btree ("next_poll_at","post_target_id") WHERE "post_metric_poll_states"."poll_lease_until" IS NULL AND "post_metric_poll_states"."next_poll_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "post_metric_snapshots_latest_idx" ON "post_metric_snapshots" USING btree ("project_id","post_target_id","captured_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "post_metric_snapshots_window_idx" ON "post_metric_snapshots" USING btree ("social_account_id","captured_at");--> statement-breakpoint
CREATE INDEX "post_metric_snapshots_captured_idx" ON "post_metric_snapshots" USING btree ("captured_at");