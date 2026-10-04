CREATE TABLE "connect_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"group_key" text NOT NULL,
	"state_hash" text NOT NULL,
	"candidates_encrypted" text,
	"expires_at" timestamp with time zone NOT NULL,
	"callback_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connect_attempts_state_hash_uq" UNIQUE("state_hash"),
	CONSTRAINT "connect_attempts_completed_after_callback" CHECK ("connect_attempts"."completed_at" is null or "connect_attempts"."callback_at" is not null),
	CONSTRAINT "connect_attempts_candidates_after_callback" CHECK ("connect_attempts"."candidates_encrypted" is null or "connect_attempts"."callback_at" is not null),
	CONSTRAINT "connect_attempts_group_key_format" CHECK ("connect_attempts"."group_key" ~ '^[a-z0-9-]+$')
);
--> statement-breakpoint
ALTER TABLE "connect_attempts" ADD CONSTRAINT "connect_attempts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connect_attempts" ADD CONSTRAINT "connect_attempts_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connect_attempts" ADD CONSTRAINT "connect_attempts_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connect_attempts_expires_idx" ON "connect_attempts" USING btree ("expires_at");