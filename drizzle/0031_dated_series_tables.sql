CREATE TABLE "standing_series_dated_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"series_id" uuid NOT NULL,
	"ordinal" smallint NOT NULL,
	"month" smallint NOT NULL,
	"day" smallint NOT NULL,
	"year" smallint,
	"key_value" text NOT NULL,
	"fields" jsonb NOT NULL,
	"media_filename" text,
	"media_asset_id" uuid,
	"next_target_date" date,
	"source_line" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "standing_series_dated_rows_project_id_uq" UNIQUE("project_id","id"),
	CONSTRAINT "standing_series_dated_rows_series_ordinal_uq" UNIQUE("series_id","ordinal"),
	CONSTRAINT "standing_series_dated_rows_month_range" CHECK ("standing_series_dated_rows"."month" BETWEEN 1 AND 12),
	CONSTRAINT "standing_series_dated_rows_day_range" CHECK ("standing_series_dated_rows"."day" >= 1 AND "standing_series_dated_rows"."day" <= CASE "standing_series_dated_rows"."month"
          WHEN 2 THEN 29
          WHEN 4 THEN 30 WHEN 6 THEN 30 WHEN 9 THEN 30 WHEN 11 THEN 30
          ELSE 31 END),
	CONSTRAINT "standing_series_dated_rows_year_range" CHECK ("standing_series_dated_rows"."year" IS NULL OR "standing_series_dated_rows"."year" BETWEEN 1 AND 9999),
	CONSTRAINT "standing_series_dated_rows_leap_year" CHECK ("standing_series_dated_rows"."year" IS NULL OR "standing_series_dated_rows"."month" <> 2 OR "standing_series_dated_rows"."day" <> 29
       OR ("standing_series_dated_rows"."year" % 4 = 0 AND ("standing_series_dated_rows"."year" % 100 <> 0 OR "standing_series_dated_rows"."year" % 400 = 0))),
	CONSTRAINT "standing_series_dated_rows_key_value_len" CHECK (btrim("standing_series_dated_rows"."key_value") <> '' AND char_length("standing_series_dated_rows"."key_value") <= 500),
	CONSTRAINT "standing_series_dated_rows_fields_shape" CHECK (jsonb_typeof("standing_series_dated_rows"."fields") = 'object'),
	CONSTRAINT "standing_series_dated_rows_media_filename_len" CHECK ("standing_series_dated_rows"."media_filename" IS NULL OR char_length("standing_series_dated_rows"."media_filename") BETWEEN 1 AND 255),
	CONSTRAINT "standing_series_dated_rows_next_target_year" CHECK ("standing_series_dated_rows"."next_target_date" IS NULL OR "standing_series_dated_rows"."year" IS NULL
       OR extract(year from "standing_series_dated_rows"."next_target_date") = "standing_series_dated_rows"."year")
);
--> statement-breakpoint
CREATE TABLE "standing_series_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"series_id" uuid NOT NULL,
	"row_id" uuid NOT NULL,
	"year" smallint NOT NULL,
	"target_date" date NOT NULL,
	"outcome" "standing_series_occurrence_outcome",
	"position_id" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "standing_series_occurrences_project_id_uq" UNIQUE("project_id","id"),
	CONSTRAINT "standing_series_occurrences_row_year_uq" UNIQUE("row_id","year"),
	CONSTRAINT "standing_series_occurrences_year_match" CHECK (extract(year from "standing_series_occurrences"."target_date") = "standing_series_occurrences"."year"),
	CONSTRAINT "standing_series_occurrences_missed_no_position" CHECK ("standing_series_occurrences"."outcome" <> 'missed' OR "standing_series_occurrences"."position_id" IS NULL),
	CONSTRAINT "standing_series_occurrences_pending_has_position" CHECK ("standing_series_occurrences"."outcome" IS NOT NULL OR "standing_series_occurrences"."position_id" IS NOT NULL),
	CONSTRAINT "standing_series_occurrences_settled_pair" CHECK (("standing_series_occurrences"."outcome" IS NULL) = ("standing_series_occurrences"."settled_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "standing_series" DROP CONSTRAINT "standing_series_cadence_count_range";--> statement-breakpoint
ALTER TABLE "standing_series" ALTER COLUMN "cadence_count" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "standing_series" ALTER COLUMN "cadence_period" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "standing_series" ALTER COLUMN "next_run_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "queue_not_before" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "standing_series" ADD COLUMN "occurrence_rule" "standing_series_occurrence_rule" DEFAULT 'cadence' NOT NULL;--> statement-breakpoint
ALTER TABLE "standing_series" ADD COLUMN "lead_days" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "standing_series" ADD COLUMN "list_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "standing_series" ADD COLUMN "last_import_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "standing_series" ADD COLUMN "last_import_filename" text;--> statement-breakpoint
ALTER TABLE "standing_series" ADD COLUMN "last_import_row_count" smallint;--> statement-breakpoint
ALTER TABLE "standing_series" ADD COLUMN "last_import_problems" jsonb;--> statement-breakpoint
ALTER TABLE "standing_series_positions" ADD COLUMN "dated" jsonb;--> statement-breakpoint
ALTER TABLE "standing_series_dated_rows" ADD CONSTRAINT "standing_series_dated_rows_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standing_series_dated_rows" ADD CONSTRAINT "standing_series_dated_rows_media_asset_id_media_assets_id_fk" FOREIGN KEY ("media_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standing_series_dated_rows" ADD CONSTRAINT "standing_series_dated_rows_series_fk" FOREIGN KEY ("project_id","series_id") REFERENCES "public"."standing_series"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standing_series_occurrences" ADD CONSTRAINT "standing_series_occurrences_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standing_series_occurrences" ADD CONSTRAINT "standing_series_occurrences_series_fk" FOREIGN KEY ("project_id","series_id") REFERENCES "public"."standing_series"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standing_series_occurrences" ADD CONSTRAINT "standing_series_occurrences_row_fk" FOREIGN KEY ("project_id","row_id") REFERENCES "public"."standing_series_dated_rows"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standing_series_occurrences" ADD CONSTRAINT "standing_series_occurrences_position_fk" FOREIGN KEY ("project_id","position_id") REFERENCES "public"."standing_series_positions"("project_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "standing_series_dated_rows_identity_uq" ON "standing_series_dated_rows" USING btree ("series_id","month","day",coalesce("year", 0),lower(btrim("key_value")));--> statement-breakpoint
CREATE INDEX "standing_series_dated_rows_due_idx" ON "standing_series_dated_rows" USING btree ("series_id","next_target_date") WHERE "standing_series_dated_rows"."next_target_date" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "standing_series_dated_rows_list_idx" ON "standing_series_dated_rows" USING btree ("project_id","series_id","ordinal");--> statement-breakpoint
CREATE INDEX "standing_series_occurrences_series_idx" ON "standing_series_occurrences" USING btree ("project_id","series_id","target_date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "standing_series_occurrences_row_idx" ON "standing_series_occurrences" USING btree ("project_id","row_id","year" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "standing_series_occurrences_prune_idx" ON "standing_series_occurrences" USING btree ("recorded_at") WHERE "standing_series_occurrences"."outcome" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "standing_series" ADD CONSTRAINT "standing_series_lead_days_range" CHECK ("standing_series"."lead_days" BETWEEN 0 AND 30);--> statement-breakpoint
ALTER TABLE "standing_series" ADD CONSTRAINT "standing_series_cadence_count_pair" CHECK (("standing_series"."occurrence_rule" = 'cadence') = ("standing_series"."cadence_count" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "standing_series" ADD CONSTRAINT "standing_series_cadence_period_pair" CHECK (("standing_series"."occurrence_rule" = 'cadence') = ("standing_series"."cadence_period" IS NOT NULL) AND "standing_series"."cadence_period"::text IS DISTINCT FROM 'date');--> statement-breakpoint
ALTER TABLE "standing_series" ADD CONSTRAINT "standing_series_next_run_at_pair" CHECK (("standing_series"."occurrence_rule" = 'cadence') = ("standing_series"."next_run_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "standing_series" ADD CONSTRAINT "standing_series_last_import_filename_pair" CHECK (("standing_series"."last_import_at" IS NULL) = ("standing_series"."last_import_filename" IS NULL));--> statement-breakpoint
ALTER TABLE "standing_series" ADD CONSTRAINT "standing_series_last_import_requires_dated" CHECK ("standing_series"."last_import_at" IS NULL OR "standing_series"."occurrence_rule" = 'dated_list');--> statement-breakpoint
ALTER TABLE "standing_series" ADD CONSTRAINT "standing_series_lead_days_requires_dated" CHECK ("standing_series"."occurrence_rule" = 'dated_list' OR "standing_series"."lead_days" = 0);--> statement-breakpoint
ALTER TABLE "standing_series" ADD CONSTRAINT "standing_series_template_fields_requires_dated" CHECK ("standing_series"."occurrence_rule" = 'dated_list' OR cardinality("standing_series"."template_fields") = 0);--> statement-breakpoint
ALTER TABLE "standing_series" ADD CONSTRAINT "standing_series_last_import_filename_len" CHECK ("standing_series"."last_import_filename" IS NULL OR char_length("standing_series"."last_import_filename") BETWEEN 1 AND 255);--> statement-breakpoint
ALTER TABLE "standing_series" ADD CONSTRAINT "standing_series_last_import_row_count_nonneg" CHECK ("standing_series"."last_import_row_count" IS NULL OR "standing_series"."last_import_row_count" >= 0);--> statement-breakpoint
ALTER TABLE "standing_series" ADD CONSTRAINT "standing_series_last_import_problems_shape" CHECK ("standing_series"."last_import_problems" IS NULL OR (jsonb_typeof("standing_series"."last_import_problems") = 'array' AND jsonb_array_length("standing_series"."last_import_problems") <= 100));--> statement-breakpoint
ALTER TABLE "standing_series" ADD CONSTRAINT "standing_series_cadence_count_range" CHECK ("standing_series"."cadence_count" IS NULL OR "standing_series"."cadence_count" BETWEEN 1 AND 10);--> statement-breakpoint
ALTER TABLE "standing_series_positions" ADD CONSTRAINT "standing_series_positions_dated_shape" CHECK ("standing_series_positions"."dated" IS NULL OR jsonb_typeof("standing_series_positions"."dated") = 'object');--> statement-breakpoint
ALTER TABLE "standing_series_runs" ADD CONSTRAINT "standing_series_runs_dated_has_no_plan" CHECK ("standing_series_runs"."period"::text <> 'date' OR "standing_series_runs"."plan" IS NULL);