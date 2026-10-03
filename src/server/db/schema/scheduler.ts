import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** System-wide (not project-owned): one row per scheduler section (FR-039). */
export const schedulerHeartbeats = pgTable("scheduler_heartbeats", {
  section: text("section").primaryKey(),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }).notNull(),
  lastSummary: jsonb("last_summary").default({}).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});
