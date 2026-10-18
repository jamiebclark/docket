ALTER TABLE "post_metric_poll_states" DROP CONSTRAINT "post_metric_poll_states_frozen_reason_enum";--> statement-breakpoint
ALTER TABLE "social_accounts" ADD COLUMN "granted_scopes" text[];--> statement-breakpoint
CREATE INDEX "social_accounts_granted_scopes_idx" ON "social_accounts" USING gin ("granted_scopes");--> statement-breakpoint
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_granted_scopes_shape" CHECK ("social_accounts"."granted_scopes" IS NULL
          OR cardinality("social_accounts"."granted_scopes") = 0
          OR (cardinality("social_accounts"."granted_scopes") <= 40
              AND octet_length(array_to_string("social_accounts"."granted_scopes", ',')) <= 1000
              AND array_to_string("social_accounts"."granted_scopes", ',') ~ '^[a-z0-9_.:-]{1,64}(,[a-z0-9_.:-]{1,64})*$'));--> statement-breakpoint
ALTER TABLE "post_metric_poll_states" ADD CONSTRAINT "post_metric_poll_states_frozen_reason_enum" CHECK ("post_metric_poll_states"."frozen_reason" IS NULL OR "post_metric_poll_states"."frozen_reason" IN ('settled', 'gone', 'expired', 'unqueryable'));