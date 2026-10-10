ALTER TYPE "public"."generation_job_item_status" ADD VALUE 'skipped';--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_project_id_uq" UNIQUE("project_id","id");--> statement-breakpoint
ALTER TABLE "generation_job_items" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "generation_job_items" ADD CONSTRAINT "generation_job_items_external_id_len" CHECK ("generation_job_items"."external_id" IS NULL OR (char_length("generation_job_items"."external_id") BETWEEN 1 AND 200 AND btrim("generation_job_items"."external_id") = "generation_job_items"."external_id"));--> statement-breakpoint
CREATE TABLE "external_item_claims" (
	"project_id" uuid NOT NULL,
	"source_key" text NOT NULL,
	"external_id" text NOT NULL,
	"post_id" uuid NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_item_claims_project_id_source_key_external_id_pk" PRIMARY KEY("project_id","source_key","external_id"),
	CONSTRAINT "external_item_claims_source_key_shape" CHECK (char_length("external_item_claims"."source_key") BETWEEN 1 AND 64 AND "external_item_claims"."source_key" ~ '^[a-z0-9][a-z0-9._:-]*$'),
	CONSTRAINT "external_item_claims_external_id_len" CHECK (char_length("external_item_claims"."external_id") BETWEEN 1 AND 200),
	CONSTRAINT "external_item_claims_external_id_trimmed" CHECK (btrim("external_item_claims"."external_id") = "external_item_claims"."external_id")
);
--> statement-breakpoint
ALTER TABLE "external_item_claims" ADD CONSTRAINT "external_item_claims_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_item_claims" ADD CONSTRAINT "external_item_claims_post_fk" FOREIGN KEY ("project_id","post_id") REFERENCES "public"."posts"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "external_item_claims_post_idx" ON "external_item_claims" USING btree ("project_id","post_id");
