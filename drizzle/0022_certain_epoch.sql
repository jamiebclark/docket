ALTER TYPE "public"."llm_failure_kind" ADD VALUE 'credit_exhausted';--> statement-breakpoint
ALTER TYPE "public"."generation_job_item_error" ADD VALUE 'credit_exhausted';--> statement-breakpoint
CREATE TABLE "llm_credit_holds" (
	"owner" text PRIMARY KEY NOT NULL,
	"held_since" timestamp with time zone NOT NULL,
	"last_refusal_at" timestamp with time zone NOT NULL,
	"next_probe_at" timestamp with time zone NOT NULL,
	CONSTRAINT "llm_credit_holds_owner_nonempty" CHECK (length("llm_credit_holds"."owner") > 0)
);
