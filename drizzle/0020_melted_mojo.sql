CREATE TABLE "notification_event_marks" (
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"event_seq" bigint NOT NULL,
	"counts_again_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_event_marks_pkey" PRIMARY KEY("project_id","user_id","event_id"),
	CONSTRAINT "notification_event_marks_seq_positive" CHECK ("notification_event_marks"."event_seq" > 0),
	CONSTRAINT "notification_event_marks_ms" CHECK ("notification_event_marks"."counts_again_at" = date_trunc('milliseconds', "notification_event_marks"."counts_again_at"))
);
--> statement-breakpoint
ALTER TABLE "notification_event_marks" ADD CONSTRAINT "notification_event_marks_member_fk" FOREIGN KEY ("project_id","user_id") REFERENCES "public"."member"("organization_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_event_marks" ADD CONSTRAINT "notification_event_marks_event_fk" FOREIGN KEY ("event_id") REFERENCES "public"."activity_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_event_marks_floor_idx" ON "notification_event_marks" USING btree ("project_id","user_id","event_seq");