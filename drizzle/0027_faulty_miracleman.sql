ALTER TYPE "public"."membership_action" ADD VALUE 'project_brand_update';--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "tagline" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "website_url" text;