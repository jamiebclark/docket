CREATE TABLE "media_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"kind" text NOT NULL,
	"declared_type" text NOT NULL,
	"declared_bytes" bigint NOT NULL,
	"part_size" integer NOT NULL,
	"part_count" integer NOT NULL,
	"transport" text NOT NULL,
	"storage_key" text NOT NULL,
	"storage_upload_id" text,
	"state" text DEFAULT 'open' NOT NULL,
	"media_asset_id" uuid,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "media_uploads_storage_key_uq" UNIQUE("project_id","storage_key"),
	CONSTRAINT "media_uploads_kind_valid" CHECK ("media_uploads"."kind" IN ('image','video')),
	CONSTRAINT "media_uploads_transport_valid" CHECK ("media_uploads"."transport" IN ('direct','via_app')),
	CONSTRAINT "media_uploads_state_valid" CHECK ("media_uploads"."state" IN ('open','completing','completed','refused','cancelled','expired')),
	CONSTRAINT "media_uploads_declared_bytes_pos" CHECK ("media_uploads"."declared_bytes" > 0),
	CONSTRAINT "media_uploads_part_size_min" CHECK ("media_uploads"."part_size" >= 5242880),
	CONSTRAINT "media_uploads_part_count_range" CHECK ("media_uploads"."part_count" BETWEEN 1 AND 10000)
);
--> statement-breakpoint
ALTER TABLE "media_assets" ALTER COLUMN "byte_size" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "kind" text DEFAULT 'image' NOT NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "processing_state" text DEFAULT 'ready' NOT NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "processing_step" text;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "processing_error" text;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "processing_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "processing_lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "processing_lease_token" uuid;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "source_storage_key" text;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "duration_ms" integer;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "frame_rate" double precision;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "video_codec" text;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "audio_codec" text;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "container" text;--> statement-breakpoint
ALTER TABLE "media_uploads" ADD CONSTRAINT "media_uploads_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_uploads" ADD CONSTRAINT "media_uploads_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_uploads" ADD CONSTRAINT "media_uploads_media_asset_id_media_assets_id_fk" FOREIGN KEY ("media_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_uploads_member_open_idx" ON "media_uploads" USING btree ("project_id","created_by_user_id") WHERE "media_uploads"."state" IN ('open','completing');--> statement-breakpoint
CREATE INDEX "media_uploads_expiry_idx" ON "media_uploads" USING btree ("created_at") WHERE "media_uploads"."state" IN ('open','completing');--> statement-breakpoint
CREATE INDEX "media_assets_processing_idx" ON "media_assets" USING btree ("created_at") WHERE "media_assets"."processing_state" = 'processing' AND "media_assets"."deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_kind_valid" CHECK ("media_assets"."kind" IN ('image','video'));--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_state_valid" CHECK ("media_assets"."processing_state" IN ('processing','ready','failed'));--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_step_valid" CHECK ("media_assets"."processing_step" IN ('queued','probing','poster'));--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_container_valid" CHECK ("media_assets"."container" IN ('mp4','mov'));--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_video_ready_facts" CHECK ("media_assets"."kind" <> 'video' OR "media_assets"."processing_state" <> 'ready' OR ("media_assets"."duration_ms" IS NOT NULL AND "media_assets"."video_codec" IS NOT NULL AND "media_assets"."container" IS NOT NULL AND "media_assets"."width" IS NOT NULL AND "media_assets"."height" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_step_matches_state" CHECK (("media_assets"."processing_state" = 'processing') = ("media_assets"."processing_step" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_error_matches_state" CHECK (("media_assets"."processing_state" = 'failed') = ("media_assets"."processing_error" IS NOT NULL));