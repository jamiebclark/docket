import { sql } from "drizzle-orm";
import { bigint, boolean, check, foreignKey, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import { member } from "./auth";

/**
 * One row per membership: a person's reading position and mute setting for one project (never one row per event).
 * `seen_seq`: every attention event for this person in this project with seq <= seen_seq is read; it only grows.
 * The composite FK to `member` deletes the state with the membership (remove, leave, project or user deletion).
 */
export const notificationStates = pgTable(
  "notification_states",
  {
    projectId: uuid("project_id").notNull(),
    userId: uuid("user_id").notNull(),
    seenSeq: bigint("seen_seq", { mode: "bigint" }).notNull().default(sql`0`),
    seenAt: timestamp("seen_at", { withTimezone: true }).defaultNow().notNull(),
    muted: boolean("muted").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    primaryKey({ name: "notification_states_pkey", columns: [t.projectId, t.userId] }),
    foreignKey({
      name: "notification_states_member_fk",
      columns: [t.projectId, t.userId],
      foreignColumns: [member.organizationId, member.userId],
    }).onDelete("cascade"),
    check("notification_states_seen_seq_nonneg", sql`${t.seenSeq} >= 0`),
  ],
);

export type NotificationStateRecord = typeof notificationStates.$inferSelect;
