import { sql } from "drizzle-orm";
import { check, pgTable, smallint, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";

/** Singleton: presence of the row means first-run bootstrap is done (research D13). */
export const installState = pgTable(
  "install_state",
  {
    id: smallint("id").primaryKey(),
    firstUserId: uuid("first_user_id").references(() => user.id, { onDelete: "set null" }),
    completedAt: timestamp("completed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [check("install_state_singleton", sql`${t.id} = 1`)],
);
