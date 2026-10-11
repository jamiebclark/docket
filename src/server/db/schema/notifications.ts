import { sql } from "drizzle-orm";
import { bigint, boolean, check, foreignKey, index, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import { activityEvents } from "./activity";
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

/**
 * At most one row per person, project and attention event, and only above that person's floor (seen_seq)
 * for that project. counts_again_at: 'infinity' = read for ever, a finite instant = snoozed until then.
 * event_seq is copied from activity_events.seq at write time (the log is append-only, so it never changes).
 */
export const notificationEventMarks = pgTable(
  "notification_event_marks",
  {
    projectId: uuid("project_id").notNull(),
    userId: uuid("user_id").notNull(),
    eventId: uuid("event_id").notNull(),
    eventSeq: bigint("event_seq", { mode: "bigint" }).notNull(),
    countsAgainAt: timestamp("counts_again_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    primaryKey({ name: "notification_event_marks_pkey", columns: [t.projectId, t.userId, t.eventId] }),
    foreignKey({
      name: "notification_event_marks_member_fk",
      columns: [t.projectId, t.userId],
      foreignColumns: [member.organizationId, member.userId],
    }).onDelete("cascade"),
    foreignKey({
      name: "notification_event_marks_event_fk",
      columns: [t.eventId],
      foreignColumns: [activityEvents.id],
    }).onDelete("cascade"),
    check("notification_event_marks_seq_positive", sql`${t.eventSeq} > 0`),
    check("notification_event_marks_ms", sql`${t.countsAgainAt} = date_trunc('milliseconds', ${t.countsAgainAt})`),
    index("notification_event_marks_floor_idx").on(t.projectId, t.userId, t.eventSeq),
  ],
);

export type NotificationEventMarkRecord = typeof notificationEventMarks.$inferSelect;
