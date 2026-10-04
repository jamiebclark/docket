ALTER TYPE "public"."publish_attempt_outcome" ADD VALUE 'resolved_not_published';--> statement-breakpoint
ALTER TYPE "public"."publish_attempt_outcome" ADD VALUE 'requeued';--> statement-breakpoint
ALTER TYPE "public"."webhook_attempt_error" ADD VALUE 'address_not_allowed';--> statement-breakpoint
CREATE INDEX "post_targets_attention_idx" ON "post_targets" USING btree ("project_id","updated_at" DESC NULLS LAST,"id") WHERE "post_targets"."status" IN ('ambiguous','failed');