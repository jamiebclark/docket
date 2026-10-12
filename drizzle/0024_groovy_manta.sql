ALTER TYPE "public"."membership_action" ADD VALUE 'llm_credential_update';--> statement-breakpoint
CREATE TABLE "project_llm_settings" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"provider" text,
	"model" text,
	"api_key_encrypted" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid,
	"last_check_at" timestamp with time zone,
	"check_lease_until" timestamp with time zone,
	CONSTRAINT "project_llm_settings_provider" CHECK ("project_llm_settings"."provider" IS NULL OR "project_llm_settings"."provider" IN ('openai','anthropic')),
	CONSTRAINT "project_llm_settings_credential" CHECK (("project_llm_settings"."provider" IS NULL AND "project_llm_settings"."model" IS NULL AND "project_llm_settings"."api_key_encrypted" IS NULL)
        OR ("project_llm_settings"."provider" IS NOT NULL AND "project_llm_settings"."model" IS NOT NULL AND "project_llm_settings"."api_key_encrypted" IS NOT NULL)),
	CONSTRAINT "project_llm_settings_model_shape" CHECK ("project_llm_settings"."model" IS NULL OR (length("project_llm_settings"."model") BETWEEN 1 AND 200 AND "project_llm_settings"."model" !~ '\s')),
	CONSTRAINT "project_llm_settings_key_nonempty" CHECK ("project_llm_settings"."api_key_encrypted" IS NULL OR length("project_llm_settings"."api_key_encrypted") > 0)
);
--> statement-breakpoint
ALTER TABLE "project_llm_settings" ADD CONSTRAINT "project_llm_settings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_llm_settings" ADD CONSTRAINT "project_llm_settings_updated_by_user_id_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;