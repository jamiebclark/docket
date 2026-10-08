CREATE TABLE "video_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"media_asset_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"recipe" jsonb NOT NULL,
	"steps" text[] NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"lease_token" uuid,
	"error" text,
	"due_at" timestamp with time zone,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"checked_at" timestamp with time zone,
	"storage_key" text,
	"public_url" text,
	"container" text,
	"width" integer,
	"height" integer,
	"duration_ms" integer,
	"frame_rate" double precision,
	"video_codec" text,
	"audio_codec" text,
	"video_bitrate" bigint,
	"byte_size" bigint,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "video_versions_asset_kind_key_uq" UNIQUE("media_asset_id","kind","key"),
	CONSTRAINT "video_versions_storage_key_uq" UNIQUE("project_id","storage_key"),
	CONSTRAINT "video_versions_kind_valid" CHECK ("video_versions"."kind" IN ('full','preview')),
	CONSTRAINT "video_versions_state_valid" CHECK ("video_versions"."state" IN ('queued','building','ready','failed')),
	CONSTRAINT "video_versions_container_valid" CHECK ("video_versions"."container" IN ('mp4','mov')),
	CONSTRAINT "video_versions_lease_pair" CHECK (("video_versions"."lease_until" IS NULL) = ("video_versions"."lease_token" IS NULL)),
	CONSTRAINT "video_versions_error_matches_state" CHECK (("video_versions"."state" = 'failed') = ("video_versions"."error" IS NOT NULL)),
	CONSTRAINT "video_versions_ready_facts" CHECK ("video_versions"."state" <> 'ready' OR ("video_versions"."storage_key" IS NOT NULL AND "video_versions"."public_url" IS NOT NULL AND "video_versions"."container" IS NOT NULL AND "video_versions"."width" IS NOT NULL AND "video_versions"."height" IS NOT NULL AND "video_versions"."duration_ms" IS NOT NULL AND "video_versions"."frame_rate" IS NOT NULL AND "video_versions"."video_codec" IS NOT NULL AND "video_versions"."video_bitrate" IS NOT NULL AND "video_versions"."byte_size" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "post_video_edits" (
	"project_id" uuid NOT NULL,
	"post_id" uuid NOT NULL,
	"media_asset_id" uuid NOT NULL,
	"trim_start_ms" integer DEFAULT 0 NOT NULL,
	"trim_end_ms" integer,
	"fit" text DEFAULT 'pad_blur' NOT NULL,
	"pad_color" text DEFAULT '#000000' NOT NULL,
	"focal_x" double precision DEFAULT 0.5 NOT NULL,
	"focal_y" double precision DEFAULT 0.5 NOT NULL,
	"recommended_shape" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "post_video_edits_post_id_media_asset_id_pk" PRIMARY KEY("post_id","media_asset_id"),
	CONSTRAINT "post_video_edits_trim_start_valid" CHECK ("post_video_edits"."trim_start_ms" >= 0 AND "post_video_edits"."trim_start_ms" % 100 = 0),
	CONSTRAINT "post_video_edits_trim_end_valid" CHECK ("post_video_edits"."trim_end_ms" IS NULL OR ("post_video_edits"."trim_end_ms" > "post_video_edits"."trim_start_ms" + 999 AND "post_video_edits"."trim_end_ms" % 100 = 0)),
	CONSTRAINT "post_video_edits_fit_valid" CHECK ("post_video_edits"."fit" IN ('pad_blur','pad_color','crop')),
	CONSTRAINT "post_video_edits_pad_color_valid" CHECK ("post_video_edits"."pad_color" ~ '^#[0-9a-f]{6}$'),
	CONSTRAINT "post_video_edits_focal_x_valid" CHECK ("post_video_edits"."focal_x" BETWEEN 0 AND 1),
	CONSTRAINT "post_video_edits_focal_y_valid" CHECK ("post_video_edits"."focal_y" BETWEEN 0 AND 1)
);
--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "video_bitrate" bigint;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "audio_bitrate" bigint;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "audio_sample_rate" integer;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "audio_channels" smallint;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "index_at_front" boolean;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "facts_version" smallint DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "facts_attempts" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "post_targets" ADD COLUMN "video_wait_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "video_versions" ADD CONSTRAINT "video_versions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_versions" ADD CONSTRAINT "video_versions_media_asset_id_media_assets_id_fk" FOREIGN KEY ("media_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_video_edits" ADD CONSTRAINT "post_video_edits_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_video_edits" ADD CONSTRAINT "post_video_edits_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_video_edits" ADD CONSTRAINT "post_video_edits_media_asset_id_media_assets_id_fk" FOREIGN KEY ("media_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "video_versions_claim_idx" ON "video_versions" USING btree ("due_at","created_at") WHERE "video_versions"."state" IN ('queued','building');--> statement-breakpoint
CREATE INDEX "video_versions_project_asset_idx" ON "video_versions" USING btree ("project_id","media_asset_id");--> statement-breakpoint
CREATE INDEX "video_versions_collect_idx" ON "video_versions" USING btree ("checked_at") WHERE "video_versions"."state" <> 'building';--> statement-breakpoint
CREATE INDEX "post_video_edits_project_post_idx" ON "post_video_edits" USING btree ("project_id","post_id");--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_facts_version_valid" CHECK ("media_assets"."facts_version" IN (1, 2));--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_video_bitrate_pos" CHECK ("media_assets"."video_bitrate" IS NULL OR "media_assets"."video_bitrate" > 0);--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_audio_bitrate_pos" CHECK ("media_assets"."audio_bitrate" IS NULL OR "media_assets"."audio_bitrate" > 0);--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_audio_sample_rate_pos" CHECK ("media_assets"."audio_sample_rate" IS NULL OR "media_assets"."audio_sample_rate" > 0);--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_audio_channels_pos" CHECK ("media_assets"."audio_channels" IS NULL OR "media_assets"."audio_channels" > 0);
--> statement-breakpoint
UPDATE media_assets SET facts_version = 1 WHERE kind = 'video';
