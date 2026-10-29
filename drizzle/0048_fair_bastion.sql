ALTER TYPE "public"."membership_action" ADD VALUE 'account_disable' BEFORE 'llm_credential_update';--> statement-breakpoint
ALTER TYPE "public"."membership_action" ADD VALUE 'account_enable' BEFORE 'llm_credential_update';--> statement-breakpoint
DROP INDEX "social_accounts_expiry_idx";--> statement-breakpoint
ALTER TABLE "social_accounts" ADD COLUMN "disabled_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "social_accounts_expiry_idx" ON "social_accounts" USING btree ("credentials_expires_at") WHERE "social_accounts"."removed_at" IS NULL AND "social_accounts"."disabled_at" IS NULL AND "social_accounts"."status" = 'active' AND "social_accounts"."credentials_expires_at" IS NOT NULL;