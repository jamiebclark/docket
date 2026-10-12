import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, index, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { activityEvents } from "./activity";
import { member } from "./auth";

/**
 * One row per membership: a person's reading position for one project (never one row per event).
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
 * One row per switch a person has touched, for one project. A switch is an attention kind or a
 * platform (a provider key). Absent means the switch is on with no position of its own (N27).
 * `on_from_seq`: NULL = off; a value = on, and only events with seq > it may notify through this
 * switch (N35). A row is never deleted to turn a switch on — it is rewritten with a position (Q2).
 */
export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    projectId: uuid("project_id").notNull(),
    userId: uuid("user_id").notNull(),
    axis: text("axis").notNull(), // 'kind' | 'platform'
    switchKey: text("switch_key").notNull(), // an attention outcome, or a provider key
    onFromSeq: bigint("on_from_seq", { mode: "bigint" }), // nullable: NULL = off
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    primaryKey({ name: "notification_preferences_pkey", columns: [t.projectId, t.userId, t.axis, t.switchKey] }),
    foreignKey({
      name: "notification_preferences_member_fk",
      columns: [t.projectId, t.userId],
      foreignColumns: [member.organizationId, member.userId],
    }).onDelete("cascade"),
    check("notification_preferences_axis", sql`${t.axis} IN ('kind', 'platform')`),
    check("notification_preferences_seq_nonneg", sql`${t.onFromSeq} IS NULL OR ${t.onFromSeq} >= 0`),
    check(
      "notification_preferences_kind_key",
      sql`${t.axis} <> 'kind' OR ${t.switchKey} IN ('failed', 'ambiguous', 'needs_reauth', 'connect_failed')`,
    ),
    check("notification_preferences_key_format", sql`${t.switchKey} ~ '^[a-z0-9_-]{1,40}$'`),
  ],
);

export type NotificationPreferenceRecord = typeof notificationPreferences.$inferSelect;

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
