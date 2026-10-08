CREATE TABLE "allowance_uses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"social_account_id" uuid NOT NULL,
	"post_target_id" uuid,
	"units" smallint NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "allowance_uses_units_positive" CHECK ("allowance_uses"."units" > 0)
);
--> statement-breakpoint
ALTER TABLE "post_targets" ADD COLUMN "chosen_post_type" text;--> statement-breakpoint
ALTER TABLE "allowance_uses" ADD CONSTRAINT "allowance_uses_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allowance_uses" ADD CONSTRAINT "allowance_uses_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allowance_uses" ADD CONSTRAINT "allowance_uses_post_target_id_post_targets_id_fk" FOREIGN KEY ("post_target_id") REFERENCES "public"."post_targets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "allowance_uses_account_created_idx" ON "allowance_uses" USING btree ("social_account_id","created_at");--> statement-breakpoint
ALTER TABLE "post_targets" ADD CONSTRAINT "post_targets_chosen_post_type_known" CHECK ("post_targets"."chosen_post_type" IS NULL OR "post_targets"."chosen_post_type" IN ('text','image','carousel','video','story','reel'));