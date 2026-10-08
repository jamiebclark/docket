-- Start every existing membership with everything read (spec 022, data-model §3). Idempotent.
INSERT INTO "notification_states" ("project_id", "user_id", "seen_seq", "seen_at")
SELECT m."organization_id", m."user_id", (SELECT coalesce(max("seq"), 0) FROM "activity_events"), now()
FROM "member" m
ON CONFLICT ("project_id", "user_id") DO NOTHING;
