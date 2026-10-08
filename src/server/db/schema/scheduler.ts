import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { socialAccounts } from "./accounts";
import { postTargets } from "./posts";
import { projects } from "./projects";

/** System-wide (not project-owned): one row per scheduler section (FR-039). */
export const schedulerHeartbeats = pgTable("scheduler_heartbeats", {
  section: text("section").primaryKey(),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }).notNull(),
  lastSummary: jsonb("last_summary").default({}).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

/**
 * Project-owned ledger of creation-allowance reservations (a provider's rolling cap on containers).
 * Written and read only inside the scheduler's claim transaction.
 */
export const allowanceUses = pgTable(
  "allowance_uses",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    socialAccountId: uuid("social_account_id")
      .notNull()
      .references(() => socialAccounts.id, { onDelete: "cascade" }),
    /** Kept for the attempt log; a deleted post does not give its containers back. */
    postTargetId: uuid("post_target_id").references(() => postTargets.id, { onDelete: "set null" }),
    units: smallint("units").notNull(),
    /** The claim's DB clock, so tests that pin the clock see the window move. */
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("allowance_uses_account_created_idx").on(t.socialAccountId, t.createdAt),
    check("allowance_uses_units_positive", sql`${t.units} > 0`),
  ],
);
