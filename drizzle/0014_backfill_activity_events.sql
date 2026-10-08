-- Backfill activity_events from existing publish state (spec 020, research P14). Idempotent: every statement is guarded by NOT EXISTS.
INSERT INTO "activity_events" ("project_id", "occurred_at", "kind", "outcome", "post_id", "post_target_id", "social_account_id", "provider_key", "provider_keys", "actor_user_id", "actor_api_key_id", "message", "details")
SELECT
	t."project_id",
	date_trunc('milliseconds', CASE
		WHEN t."status" = 'published' THEN COALESCE(t."published_at", t."updated_at")
		ELSE COALESCE(
			(SELECT max(a."created_at") FROM "publish_attempts" a
				WHERE a."project_id" = t."project_id" AND a."post_target_id" = t."id"
				AND a."outcome" IN ('fatal_error', 'retryable_error', 'ambiguous', 'account_unavailable', 'did_not_complete', 'recovered_ambiguous', 'recovered_retry', 'resolved_failed', 'resolved_not_published')),
			t."updated_at")
	END),
	(CASE t."status" WHEN 'published' THEN 'target_published' WHEN 'failed' THEN 'target_failed' ELSE 'target_ambiguous' END)::"activity_event_kind",
	(CASE t."status" WHEN 'published' THEN 'published' WHEN 'failed' THEN 'failed' ELSE 'ambiguous' END)::"activity_outcome",
	t."post_id",
	t."id",
	t."social_account_id",
	s."provider_key",
	ARRAY[s."provider_key"],
	CASE WHEN t."resolved_at" IS NOT NULL THEN t."resolved_by_user_id" END,
	CASE WHEN t."resolved_at" IS NOT NULL THEN t."resolved_by_api_key_id" END,
	CASE
		WHEN t."status" = 'published' THEN 'Published.'
		WHEN NULLIF(btrim(t."last_error"), '') IS NULL THEN CASE t."status" WHEN 'failed' THEN 'Failed.' ELSE 'May have published.' END
		WHEN char_length(t."last_error") > 500 THEN left(t."last_error", 499) || '…'
		ELSE t."last_error"
	END,
	CASE WHEN t."status" = 'published' AND t."external_url" IS NOT NULL AND octet_length(t."external_url") <= 1900
		THEN jsonb_build_object('backfilled', true, 'url', t."external_url")
		ELSE jsonb_build_object('backfilled', true)
	END
FROM "post_targets" t
INNER JOIN "social_accounts" s ON s."project_id" = t."project_id" AND s."id" = t."social_account_id"
WHERE t."status" IN ('published', 'failed', 'ambiguous')
	AND NOT EXISTS (SELECT 1 FROM "activity_events" e WHERE e."project_id" = t."project_id" AND e."post_target_id" = t."id");
--> statement-breakpoint
INSERT INTO "activity_events" ("project_id", "occurred_at", "kind", "outcome", "social_account_id", "provider_key", "provider_keys", "message", "details")
SELECT
	s."project_id",
	date_trunc('milliseconds', s."updated_at"),
	'account_needs_reauth',
	'needs_reauth',
	s."id",
	s."provider_key",
	ARRAY[s."provider_key"],
	CASE
		WHEN NULLIF(btrim(s."last_error"), '') IS NULL THEN 'This account needs reconnecting.'
		WHEN char_length(s."last_error") > 500 THEN left(s."last_error", 499) || '…'
		ELSE s."last_error"
	END,
	'{"backfilled": true, "reason": "renewal_refused"}'::jsonb
FROM "social_accounts" s
WHERE s."status" = 'needs_reauth' AND s."removed_at" IS NULL
	AND NOT EXISTS (
		SELECT 1 FROM "activity_events" e
		WHERE e."project_id" = s."project_id" AND e."social_account_id" = s."id" AND e."kind" = 'account_needs_reauth');
