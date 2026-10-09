ALTER TABLE "post_targets" ADD COLUMN "posting_fields" jsonb;--> statement-breakpoint
ALTER TABLE "post_targets" ADD COLUMN "consent_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "post_targets" ADD COLUMN "consent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "post_targets" ADD COLUMN "consent_fingerprint" text;--> statement-breakpoint
ALTER TABLE "post_targets" ADD COLUMN "consent_details" jsonb;--> statement-breakpoint
ALTER TABLE "post_targets" ADD CONSTRAINT "post_targets_consent_by_user_id_user_id_fk" FOREIGN KEY ("consent_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_targets" ADD CONSTRAINT "post_targets_consent_pair" CHECK (("post_targets"."consent_at" IS NULL) = ("post_targets"."consent_fingerprint" IS NULL) AND ("post_targets"."consent_details" IS NULL OR "post_targets"."consent_fingerprint" IS NOT NULL));