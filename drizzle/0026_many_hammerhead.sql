CREATE TYPE "public"."llm_usage_purpose" AS ENUM('generate.single', 'generate.series_plan', 'generate.series_post', 'generate.regenerate', 'generate.job_item', 'voice.try', 'llm.check');--> statement-breakpoint
CREATE TABLE "llm_call_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"purpose" "llm_usage_purpose" NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"credential_source" text NOT NULL,
	"ok" boolean NOT NULL,
	"failure_kind" "llm_failure_kind",
	"input_tokens" integer,
	"output_tokens" integer,
	"latency_ms" integer NOT NULL,
	"called_at" timestamp with time zone NOT NULL,
	"post_id" uuid,
	"series_id" uuid,
	"series_position" smallint,
	"generation_job_id" uuid,
	"generation_job_item_id" uuid,
	CONSTRAINT "llm_call_usage_outcome" CHECK ("llm_call_usage"."ok" = ("llm_call_usage"."failure_kind" IS NULL)),
	CONSTRAINT "llm_call_usage_series_pair" CHECK (("llm_call_usage"."series_id" IS NULL) = ("llm_call_usage"."series_position" IS NULL)),
	CONSTRAINT "llm_call_usage_tokens_nonneg" CHECK (("llm_call_usage"."input_tokens" IS NULL OR "llm_call_usage"."input_tokens" >= 0) AND ("llm_call_usage"."output_tokens" IS NULL OR "llm_call_usage"."output_tokens" >= 0)),
	CONSTRAINT "llm_call_usage_latency_nonneg" CHECK ("llm_call_usage"."latency_ms" >= 0),
	CONSTRAINT "llm_call_usage_provider" CHECK ("llm_call_usage"."provider" IN ('openai','anthropic')),
	CONSTRAINT "llm_call_usage_source" CHECK ("llm_call_usage"."credential_source" IN ('project','install')),
	CONSTRAINT "llm_call_usage_model_shape" CHECK (length("llm_call_usage"."model") BETWEEN 1 AND 200 AND "llm_call_usage"."model" !~ '\s'),
	CONSTRAINT "llm_call_usage_job_pair" CHECK ("llm_call_usage"."generation_job_item_id" IS NULL OR "llm_call_usage"."generation_job_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "llm_call_usage" ADD CONSTRAINT "llm_call_usage_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_call_usage" ADD CONSTRAINT "llm_call_usage_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_call_usage" ADD CONSTRAINT "llm_call_usage_series_fk" FOREIGN KEY ("project_id","series_id") REFERENCES "public"."generation_series"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_call_usage" ADD CONSTRAINT "llm_call_usage_job_fk" FOREIGN KEY ("project_id","generation_job_id") REFERENCES "public"."generation_jobs"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_call_usage" ADD CONSTRAINT "llm_call_usage_job_item_fk" FOREIGN KEY ("project_id","generation_job_item_id") REFERENCES "public"."generation_job_items"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "llm_call_usage_project_called_idx" ON "llm_call_usage" USING btree ("project_id","called_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "llm_call_usage_project_job_idx" ON "llm_call_usage" USING btree ("project_id","generation_job_id") WHERE "llm_call_usage"."generation_job_id" IS NOT NULL;