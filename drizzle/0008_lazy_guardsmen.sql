ALTER TYPE "public"."membership_action" ADD VALUE 'account_posting_instructions_update';--> statement-breakpoint
ALTER TABLE "social_accounts" ADD COLUMN "posting_instructions" text;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "posting_instructions_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_posting_instructions_len" CHECK ("social_accounts"."posting_instructions" IS NULL OR char_length("social_accounts"."posting_instructions") BETWEEN 1 AND 2000);