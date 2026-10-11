CREATE TABLE "notification_preferences" (
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"axis" text NOT NULL,
	"switch_key" text NOT NULL,
	"on_from_seq" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preferences_pkey" PRIMARY KEY("project_id","user_id","axis","switch_key"),
	CONSTRAINT "notification_preferences_axis" CHECK ("notification_preferences"."axis" IN ('kind', 'platform')),
	CONSTRAINT "notification_preferences_seq_nonneg" CHECK ("notification_preferences"."on_from_seq" IS NULL OR "notification_preferences"."on_from_seq" >= 0),
	CONSTRAINT "notification_preferences_kind_key" CHECK ("notification_preferences"."axis" <> 'kind' OR "notification_preferences"."switch_key" IN ('failed', 'ambiguous', 'needs_reauth', 'connect_failed')),
	CONSTRAINT "notification_preferences_key_format" CHECK ("notification_preferences"."switch_key" ~ '^[a-z0-9_-]{1,40}$')
);
--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_member_fk" FOREIGN KEY ("project_id","user_id") REFERENCES "public"."member"("organization_id","user_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Every muted project becomes all four kinds off, so no one's choice is lost (N26). Unmuted rows get
-- nothing: absent means on (N27). No seen_seq, seen_at or sparse mark is touched.
INSERT INTO "notification_preferences" ("project_id", "user_id", "axis", "switch_key", "on_from_seq")
SELECT s."project_id", s."user_id", 'kind', k."key", NULL
  FROM "notification_states" s
 CROSS JOIN (VALUES ('failed'), ('ambiguous'), ('needs_reauth'), ('connect_failed')) AS k("key")
 WHERE s."muted" = true
ON CONFLICT DO NOTHING;
--> statement-breakpoint
ALTER TABLE "notification_states" DROP COLUMN "muted";
