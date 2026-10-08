CREATE TABLE "notification_states" (
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"seen_seq" bigint DEFAULT 0 NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"muted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_states_pkey" PRIMARY KEY("project_id","user_id"),
	CONSTRAINT "notification_states_seen_seq_nonneg" CHECK ("notification_states"."seen_seq" >= 0)
);
--> statement-breakpoint
ALTER TABLE "notification_states" ADD CONSTRAINT "notification_states_member_fk" FOREIGN KEY ("project_id","user_id") REFERENCES "public"."member"("organization_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_events_attention_seq_idx" ON "activity_events" USING btree ("project_id","seq") WHERE "activity_events"."outcome" IN ('failed', 'ambiguous', 'needs_reauth');--> statement-breakpoint
CREATE INDEX "activity_events_connect_failed_actor_idx" ON "activity_events" USING btree ("project_id","actor_user_id","seq") WHERE "activity_events"."outcome" = 'connect_failed';