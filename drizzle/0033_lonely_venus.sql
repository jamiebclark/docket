ALTER TABLE "standing_series_occurrences" DROP CONSTRAINT "standing_series_occurrences_position_fk";
--> statement-breakpoint
ALTER TABLE "standing_series_occurrences" ADD CONSTRAINT "standing_series_occurrences_position_id_standing_series_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."standing_series_positions"("id") ON DELETE set null ON UPDATE no action;