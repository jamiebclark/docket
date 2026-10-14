CREATE TYPE "public"."standing_series_occurrence_outcome" AS ENUM('produced', 'failed', 'skipped', 'missed');--> statement-breakpoint
CREATE TYPE "public"."standing_series_occurrence_rule" AS ENUM('cadence', 'dated_list');--> statement-breakpoint
ALTER TYPE "public"."standing_series_period" ADD VALUE 'date';--> statement-breakpoint
ALTER TYPE "public"."standing_series_position_status" ADD VALUE 'missed';
