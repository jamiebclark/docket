CREATE TYPE "public"."api_idempotency_state" AS ENUM('in_progress', 'completed');--> statement-breakpoint
CREATE TYPE "public"."api_key_permission" AS ENUM('read', 'write_posts', 'generate', 'auto_approve', 'manage_jobs');--> statement-breakpoint
CREATE TYPE "public"."webhook_attempt_error" AS ENUM('timeout', 'connect', 'dns', 'tls', 'redirect', 'http_status', 'endpoint_disabled', 'internal');--> statement-breakpoint
CREATE TYPE "public"."webhook_delivery_status" AS ENUM('pending', 'delivering', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."webhook_event_type" AS ENUM('post.published', 'post.failed', 'job.finished', 'account.needs_reauth', 'ping');--> statement-breakpoint
ALTER TYPE "public"."membership_action" ADD VALUE 'api_key_create';--> statement-breakpoint
ALTER TYPE "public"."membership_action" ADD VALUE 'api_key_revoke';--> statement-breakpoint
ALTER TYPE "public"."membership_action" ADD VALUE 'webhook_create';--> statement-breakpoint
ALTER TYPE "public"."membership_action" ADD VALUE 'webhook_update';--> statement-breakpoint
ALTER TYPE "public"."membership_action" ADD VALUE 'webhook_delete';--> statement-breakpoint
ALTER TYPE "public"."membership_action" ADD VALUE 'webhook_rotate_secret';--> statement-breakpoint
ALTER TYPE "public"."membership_action" ADD VALUE 'webhook_enable';--> statement-breakpoint
ALTER TYPE "public"."membership_action" ADD VALUE 'webhook_disable';--> statement-breakpoint
CREATE TABLE "api_idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"api_key_id" uuid NOT NULL,
	"method" text NOT NULL,
	"route" text NOT NULL,
	"idem_key" text NOT NULL,
	"body_hash" text NOT NULL,
	"state" "api_idempotency_state" NOT NULL,
	"lock_token" uuid,
	"hold_until" timestamp with time zone,
	"response_status" smallint,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "api_idempotency_keys_uq" UNIQUE("api_key_id","method","route","idem_key"),
	CONSTRAINT "api_idempotency_keys_method" CHECK ("api_idempotency_keys"."method" IN ('POST','PATCH','DELETE')),
	CONSTRAINT "api_idempotency_keys_route_len" CHECK (char_length("api_idempotency_keys"."route") <= 512),
	CONSTRAINT "api_idempotency_keys_idem_key" CHECK ("api_idempotency_keys"."idem_key" ~ '^[!-~]{1,255}$'),
	CONSTRAINT "api_idempotency_keys_lock_state" CHECK (("api_idempotency_keys"."state" = 'in_progress') = ("api_idempotency_keys"."lock_token" IS NOT NULL AND "api_idempotency_keys"."hold_until" IS NOT NULL)),
	CONSTRAINT "api_idempotency_keys_completed_state" CHECK (("api_idempotency_keys"."state" = 'completed') = ("api_idempotency_keys"."response_status" IS NOT NULL AND "api_idempotency_keys"."completed_at" IS NOT NULL)),
	CONSTRAINT "api_idempotency_keys_status_lt_500" CHECK ("api_idempotency_keys"."response_status" IS NULL OR "api_idempotency_keys"."response_status" < 500)
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"last4" text NOT NULL,
	"permissions" "api_key_permission"[] NOT NULL,
	"rate_limit_per_minute" integer DEFAULT 60 NOT NULL,
	"expires_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" uuid,
	"rate_window_start" timestamp with time zone,
	"rate_window_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "api_keys_project_id_uq" UNIQUE("project_id","id"),
	CONSTRAINT "api_keys_key_hash_uq" UNIQUE("key_hash"),
	CONSTRAINT "api_keys_name_len" CHECK (char_length("api_keys"."name") BETWEEN 1 AND 64),
	CONSTRAINT "api_keys_last4_len" CHECK (char_length("api_keys"."last4") = 4),
	CONSTRAINT "api_keys_permissions_card" CHECK (cardinality("api_keys"."permissions") >= 1),
	CONSTRAINT "api_keys_rate_limit_range" CHECK ("api_keys"."rate_limit_per_minute" BETWEEN 1 AND 1000),
	CONSTRAINT "api_keys_revoker_implies_revoked" CHECK ("api_keys"."revoked_by_user_id" IS NULL OR "api_keys"."revoked_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"status" "webhook_delivery_status" DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" uuid,
	"lease_until" timestamp with time zone,
	"last_status_code" smallint,
	"last_error_kind" "webhook_attempt_error",
	"resend_of" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "webhook_deliveries_project_id_uq" UNIQUE("project_id","id"),
	CONSTRAINT "webhook_deliveries_attempt_range" CHECK ("webhook_deliveries"."attempt_count" BETWEEN 0 AND 8),
	CONSTRAINT "webhook_deliveries_lease_pair" CHECK (("webhook_deliveries"."lease_owner" IS NULL) = ("webhook_deliveries"."lease_until" IS NULL)),
	CONSTRAINT "webhook_deliveries_delivering_leased" CHECK (("webhook_deliveries"."status" = 'delivering') = ("webhook_deliveries"."lease_owner" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "webhook_delivery_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"delivery_id" uuid NOT NULL,
	"attempt" smallint NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"status_code" smallint,
	"error_kind" "webhook_attempt_error",
	"duration_ms" integer NOT NULL,
	"response_excerpt" text,
	CONSTRAINT "webhook_delivery_attempts_attempt_range" CHECK ("webhook_delivery_attempts"."attempt" BETWEEN 1 AND 8),
	CONSTRAINT "webhook_delivery_attempts_outcome" CHECK ("webhook_delivery_attempts"."status_code" IS NOT NULL OR "webhook_delivery_attempts"."error_kind" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"url" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"events" "webhook_event_type"[] NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"disabled_reason" text,
	"secret_encrypted" text NOT NULL,
	"previous_secret_encrypted" text,
	"previous_secret_expires_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_endpoints_project_id_uq" UNIQUE("project_id","id"),
	CONSTRAINT "webhook_endpoints_url_len" CHECK (char_length("webhook_endpoints"."url") <= 2000),
	CONSTRAINT "webhook_endpoints_description_len" CHECK (char_length("webhook_endpoints"."description") <= 200),
	CONSTRAINT "webhook_endpoints_events_card" CHECK (cardinality("webhook_endpoints"."events") >= 1),
	CONSTRAINT "webhook_endpoints_disabled_reason" CHECK ("webhook_endpoints"."disabled_reason" IS NULL OR "webhook_endpoints"."disabled_reason" IN ('gone','failing','manual')),
	CONSTRAINT "webhook_endpoints_disabled_has_reason" CHECK ("webhook_endpoints"."enabled" OR "webhook_endpoints"."disabled_reason" IS NOT NULL),
	CONSTRAINT "webhook_endpoints_previous_pair" CHECK (("webhook_endpoints"."previous_secret_encrypted" IS NULL) = ("webhook_endpoints"."previous_secret_expires_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"type" "webhook_event_type" NOT NULL,
	"subject_id" uuid NOT NULL,
	"body" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_events_project_id_uq" UNIQUE("project_id","id")
);
--> statement-breakpoint
ALTER TABLE "generation_jobs" DROP CONSTRAINT "generation_jobs_item_count_range";--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "created_by_api_key_id" uuid;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "created_by_api_key_id" uuid;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "created_by_api_key_id" uuid;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "cancelled_by_api_key_id" uuid;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "open" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "api_idempotency_keys" ADD CONSTRAINT "api_idempotency_keys_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_idempotency_keys" ADD CONSTRAINT "api_idempotency_keys_api_key_fk" FOREIGN KEY ("project_id","api_key_id") REFERENCES "public"."api_keys"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_revoked_by_user_id_user_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_event_fk" FOREIGN KEY ("project_id","event_id") REFERENCES "public"."webhook_events"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_fk" FOREIGN KEY ("project_id","endpoint_id") REFERENCES "public"."webhook_endpoints"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_delivery_attempts" ADD CONSTRAINT "webhook_delivery_attempts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_delivery_attempts" ADD CONSTRAINT "webhook_delivery_attempts_delivery_fk" FOREIGN KEY ("project_id","delivery_id") REFERENCES "public"."webhook_deliveries"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_idempotency_keys_expires_idx" ON "api_idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "api_keys_project_created_idx" ON "api_keys" USING btree ("project_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "webhook_deliveries_claim_idx" ON "webhook_deliveries" USING btree ("next_attempt_at") WHERE "webhook_deliveries"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "webhook_deliveries_recovery_idx" ON "webhook_deliveries" USING btree ("lease_until") WHERE "webhook_deliveries"."status" = 'delivering';--> statement-breakpoint
CREATE INDEX "webhook_deliveries_endpoint_idx" ON "webhook_deliveries" USING btree ("project_id","endpoint_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "webhook_delivery_attempts_delivery_idx" ON "webhook_delivery_attempts" USING btree ("project_id","delivery_id","attempt");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_enabled_idx" ON "webhook_endpoints" USING btree ("project_id") WHERE "webhook_endpoints"."enabled";--> statement-breakpoint
CREATE INDEX "webhook_events_project_created_idx" ON "webhook_events" USING btree ("project_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_api_key_fk" FOREIGN KEY ("project_id","created_by_api_key_id") REFERENCES "public"."api_keys"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_api_key_fk" FOREIGN KEY ("project_id","created_by_api_key_id") REFERENCES "public"."api_keys"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_created_api_key_fk" FOREIGN KEY ("project_id","created_by_api_key_id") REFERENCES "public"."api_keys"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_cancelled_api_key_fk" FOREIGN KEY ("project_id","cancelled_by_api_key_id") REFERENCES "public"."api_keys"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_open_or_items" CHECK ("generation_jobs"."open" OR "generation_jobs"."item_count" >= 1 OR "generation_jobs"."status" = 'cancelled');--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_item_count_range" CHECK ("generation_jobs"."item_count" BETWEEN 0 AND 500);