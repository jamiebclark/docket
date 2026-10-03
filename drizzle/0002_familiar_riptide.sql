CREATE TABLE "media_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"media_asset_id" uuid NOT NULL,
	"constraints_hash" text NOT NULL,
	"storage_key" text NOT NULL,
	"public_url" text NOT NULL,
	"mime_type" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"byte_size" integer NOT NULL,
	"steps" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_variants_asset_hash_uq" UNIQUE("media_asset_id","constraints_hash"),
	CONSTRAINT "media_variants_storage_key_uq" UNIQUE("project_id","storage_key"),
	CONSTRAINT "media_variants_width_pos" CHECK ("media_variants"."width" > 0),
	CONSTRAINT "media_variants_height_pos" CHECK ("media_variants"."height" > 0),
	CONSTRAINT "media_variants_byte_size_pos" CHECK ("media_variants"."byte_size" > 0)
);
--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "thumbnail_storage_key" text;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "thumbnail_url" text;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "original_filename" text;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "tags" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "media_variants" ADD CONSTRAINT "media_variants_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_variants" ADD CONSTRAINT "media_variants_media_asset_id_media_assets_id_fk" FOREIGN KEY ("media_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_variants_project_asset_idx" ON "media_variants" USING btree ("project_id","media_asset_id");--> statement-breakpoint
CREATE INDEX "media_assets_tags_gin" ON "media_assets" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "media_assets_live_idx" ON "media_assets" USING btree ("project_id","created_at" DESC NULLS LAST) WHERE "media_assets"."deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_tags_max" CHECK (cardinality("media_assets"."tags") <= 20);