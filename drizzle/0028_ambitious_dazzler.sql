ALTER TYPE "public"."llm_usage_purpose" ADD VALUE 'image.generate';--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "generated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "generation_prompt" text;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "generation_provider" text;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "generation_model" text;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_generation_all_or_none" CHECK (("media_assets"."generated_at" IS NULL AND "media_assets"."generation_prompt" IS NULL AND "media_assets"."generation_provider" IS NULL AND "media_assets"."generation_model" IS NULL)
        OR ("media_assets"."generated_at" IS NOT NULL AND "media_assets"."generation_prompt" IS NOT NULL AND "media_assets"."generation_provider" IS NOT NULL AND "media_assets"."generation_model" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_generation_prompt_shape" CHECK ("media_assets"."generation_prompt" IS NULL OR length("media_assets"."generation_prompt") BETWEEN 1 AND 1000);--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_generation_model_shape" CHECK ("media_assets"."generation_model" IS NULL OR (length("media_assets"."generation_model") BETWEEN 1 AND 200 AND "media_assets"."generation_model" !~ '\s'));--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_generation_provider_shape" CHECK ("media_assets"."generation_provider" IS NULL OR length("media_assets"."generation_provider") BETWEEN 1 AND 50);