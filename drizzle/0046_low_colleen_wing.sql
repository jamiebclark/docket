ALTER TABLE "post_targets" ADD COLUMN "public_post_id" text;--> statement-breakpoint
ALTER TABLE "account_metric_poll_states" ADD COLUMN "unavailable_reason" text;--> statement-breakpoint
ALTER TABLE "account_metric_poll_states" ADD COLUMN "unavailable_docs_path" text;--> statement-breakpoint
ALTER TABLE "post_metric_poll_states" ADD COLUMN "unavailable_reason" text;--> statement-breakpoint
ALTER TABLE "post_metric_poll_states" ADD COLUMN "unavailable_docs_path" text;--> statement-breakpoint
ALTER TABLE "post_targets" ADD CONSTRAINT "post_targets_public_post_id_len" CHECK ("post_targets"."public_post_id" IS NULL OR char_length("post_targets"."public_post_id") BETWEEN 1 AND 64);--> statement-breakpoint
ALTER TABLE "account_metric_poll_states" ADD CONSTRAINT "account_metric_poll_states_unavailable_reason_len" CHECK ("account_metric_poll_states"."unavailable_reason" IS NULL OR char_length("account_metric_poll_states"."unavailable_reason") <= 500);--> statement-breakpoint
ALTER TABLE "account_metric_poll_states" ADD CONSTRAINT "account_metric_poll_states_unavailable_docs_pair" CHECK ("account_metric_poll_states"."unavailable_docs_path" IS NULL OR "account_metric_poll_states"."unavailable_reason" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "account_metric_poll_states" ADD CONSTRAINT "account_metric_poll_states_unavailable_docs_path_len" CHECK ("account_metric_poll_states"."unavailable_docs_path" IS NULL OR char_length("account_metric_poll_states"."unavailable_docs_path") <= 100);--> statement-breakpoint
ALTER TABLE "post_metric_poll_states" ADD CONSTRAINT "post_metric_poll_states_unavailable_reason_len" CHECK ("post_metric_poll_states"."unavailable_reason" IS NULL OR char_length("post_metric_poll_states"."unavailable_reason") <= 500);--> statement-breakpoint
ALTER TABLE "post_metric_poll_states" ADD CONSTRAINT "post_metric_poll_states_unavailable_docs_pair" CHECK ("post_metric_poll_states"."unavailable_docs_path" IS NULL OR "post_metric_poll_states"."unavailable_reason" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "post_metric_poll_states" ADD CONSTRAINT "post_metric_poll_states_unavailable_docs_path_len" CHECK ("post_metric_poll_states"."unavailable_docs_path" IS NULL OR char_length("post_metric_poll_states"."unavailable_docs_path") <= 100);--> statement-breakpoint
UPDATE post_targets t
   SET public_post_id = src.id
  FROM (
    SELECT DISTINCT ON (a.post_target_id)
           a.post_target_id,
           a.response_summary -> 'publicPostIds' ->> 0 AS id
      FROM publish_attempts a
     WHERE jsonb_typeof(a.response_summary) = 'object'
       AND a.response_summary -> 'publicPostIds' ->> 0 IS NOT NULL
     ORDER BY a.post_target_id, a.created_at DESC
  ) src
 WHERE t.id = src.post_target_id
   AND t.public_post_id IS NULL
   AND char_length(src.id) BETWEEN 1 AND 64;
