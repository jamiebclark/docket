CREATE TABLE "email_delivery_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"purpose" text NOT NULL,
	"cadence" text,
	"problem_count" integer DEFAULT 0 NOT NULL,
	"outcome" text NOT NULL,
	"smtp_code" smallint,
	"duration_ms" integer NOT NULL,
	CONSTRAINT "email_delivery_attempts_purpose" CHECK ("email_delivery_attempts"."purpose" IN ('problems','invitation')),
	CONSTRAINT "email_delivery_attempts_cadence" CHECK ("email_delivery_attempts"."cadence" IS NULL OR "email_delivery_attempts"."cadence" IN ('immediate','digest')),
	CONSTRAINT "email_delivery_attempts_outcome" CHECK ("email_delivery_attempts"."outcome" IN ('sent','unavailable','refused','rejected','timed_out','connect_failed','tls_failed','internal')),
	CONSTRAINT "email_delivery_attempts_cadence_purpose" CHECK (("email_delivery_attempts"."purpose" = 'problems') = ("email_delivery_attempts"."cadence" IS NOT NULL)),
	CONSTRAINT "email_delivery_attempts_count_nonneg" CHECK ("email_delivery_attempts"."problem_count" >= 0),
	CONSTRAINT "email_delivery_attempts_duration_nonneg" CHECK ("email_delivery_attempts"."duration_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "email_project_state" (
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"mailed_seq" bigint DEFAULT 0 NOT NULL,
	"excluded" boolean DEFAULT false NOT NULL,
	"sending_seq" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_project_state_project_id_user_id_pk" PRIMARY KEY("project_id","user_id"),
	CONSTRAINT "email_project_state_mailed_nonneg" CHECK ("email_project_state"."mailed_seq" >= 0),
	CONSTRAINT "email_project_state_sending_fwd" CHECK ("email_project_state"."sending_seq" IS NULL OR "email_project_state"."sending_seq" >= "email_project_state"."mailed_seq")
);
--> statement-breakpoint
CREATE TABLE "email_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"cadence" text DEFAULT 'off' NOT NULL,
	"digest_hour" smallint DEFAULT 7 NOT NULL,
	"time_zone" text,
	"quiet_start_hour" smallint,
	"quiet_end_hour" smallint,
	"next_due_at" timestamp with time zone,
	"lease_owner" uuid,
	"lease_until" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"paused_at" timestamp with time zone,
	"paused_reason" text,
	"last_attempt_at" timestamp with time zone,
	"last_outcome" text,
	"last_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_settings_cadence" CHECK ("email_settings"."cadence" IN ('off','immediate','digest')),
	CONSTRAINT "email_settings_digest_hour" CHECK ("email_settings"."digest_hour" BETWEEN 0 AND 23),
	CONSTRAINT "email_settings_quiet_pair" CHECK (("email_settings"."quiet_start_hour" IS NULL) = ("email_settings"."quiet_end_hour" IS NULL)),
	CONSTRAINT "email_settings_quiet_start" CHECK ("email_settings"."quiet_start_hour" IS NULL OR "email_settings"."quiet_start_hour" BETWEEN 0 AND 23),
	CONSTRAINT "email_settings_quiet_end" CHECK ("email_settings"."quiet_end_hour" IS NULL OR "email_settings"."quiet_end_hour" BETWEEN 0 AND 23),
	CONSTRAINT "email_settings_lease_pair" CHECK (("email_settings"."lease_owner" IS NULL) = ("email_settings"."lease_until" IS NULL)),
	CONSTRAINT "email_settings_pause_pair" CHECK (("email_settings"."paused_at" IS NULL) = ("email_settings"."paused_reason" IS NULL)),
	CONSTRAINT "email_settings_pause_reason" CHECK ("email_settings"."paused_reason" IS NULL OR "email_settings"."paused_reason" IN ('rejected','failing')),
	CONSTRAINT "email_settings_due_when_on" CHECK (("email_settings"."cadence" = 'off') = ("email_settings"."next_due_at" IS NULL)),
	CONSTRAINT "email_settings_failures_nonneg" CHECK ("email_settings"."consecutive_failures" >= 0),
	CONSTRAINT "email_settings_outcome" CHECK ("email_settings"."last_outcome" IS NULL OR "email_settings"."last_outcome" IN
        ('sent','unavailable','refused','rejected','timed_out','connect_failed','tls_failed','internal'))
);
--> statement-breakpoint
ALTER TABLE "email_delivery_attempts" ADD CONSTRAINT "email_delivery_attempts_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_project_state" ADD CONSTRAINT "email_project_state_member_fk" FOREIGN KEY ("project_id","user_id") REFERENCES "public"."member"("organization_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_settings" ADD CONSTRAINT "email_settings_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_delivery_attempts_user_idx" ON "email_delivery_attempts" USING btree ("user_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "email_delivery_attempts_purge_idx" ON "email_delivery_attempts" USING btree ("at");--> statement-breakpoint
CREATE INDEX "email_settings_due_idx" ON "email_settings" USING btree ("next_due_at") WHERE "email_settings"."cadence" <> 'off' AND "email_settings"."paused_at" IS NULL AND "email_settings"."lease_owner" IS NULL;