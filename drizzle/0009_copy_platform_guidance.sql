-- Copy each project's default-profile platform guidance onto its matching accounts
-- (feature 011). Idempotent: only accounts with NULL instructions change.
UPDATE "social_accounts" AS sa
SET "posting_instructions" = g.text,
    "updated_at" = now()
FROM (
  SELECT p.id AS project_id,
         e.key AS provider_key,
         replace(replace(e.value, E'\r\n', E'\n'), E'\r', E'\n') AS text
  FROM "projects" p
  JOIN LATERAL (
    SELECT v.content
    FROM "voice_profile_versions" v
    WHERE v.project_id = p.id AND v.profile_id = p.default_voice_profile_id
    ORDER BY v.version DESC
    LIMIT 1
  ) latest ON true
  CROSS JOIN LATERAL jsonb_each_text(
    CASE WHEN jsonb_typeof(latest.content -> 'platformGuidance') = 'object'
         THEN latest.content -> 'platformGuidance' ELSE '{}'::jsonb END
  ) AS e(key, value)
  WHERE p.default_voice_profile_id IS NOT NULL
) AS g
WHERE sa.project_id = g.project_id
  AND sa.provider_key = g.provider_key
  AND sa.removed_at IS NULL
  AND sa.posting_instructions IS NULL
  AND char_length(g.text) BETWEEN 1 AND 2000;
