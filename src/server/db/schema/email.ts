import { sql } from "drizzle-orm";
import { bigint, boolean, check, foreignKey, index, integer, pgTable, primaryKey, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { member, user } from "./auth";

/** One row per person. Absence means email is off (N45, FR-007); no migration writes a row. */
export const emailSettings = pgTable(
  "email_settings",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    cadence: text("cadence").default("off").notNull(),
    digestHour: smallint("digest_hour").default(7).notNull(),
    timeZone: text("time_zone"),
    quietStartHour: smallint("quiet_start_hour"),
    quietEndHour: smallint("quiet_end_hour"),
    nextDueAt: timestamp("next_due_at", { withTimezone: true }),
    leaseOwner: uuid("lease_owner"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    consecutiveFailures: integer("consecutive_failures").default(0).notNull(),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    pausedReason: text("paused_reason"),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    lastOutcome: text("last_outcome"),
    lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [
    check("email_settings_cadence", sql`${t.cadence} IN ('off','immediate','digest')`),
    check("email_settings_digest_hour", sql`${t.digestHour} BETWEEN 0 AND 23`),
    check("email_settings_quiet_pair", sql`(${t.quietStartHour} IS NULL) = (${t.quietEndHour} IS NULL)`),
    check("email_settings_quiet_start", sql`${t.quietStartHour} IS NULL OR ${t.quietStartHour} BETWEEN 0 AND 23`),
    check("email_settings_quiet_end", sql`${t.quietEndHour} IS NULL OR ${t.quietEndHour} BETWEEN 0 AND 23`),
    check("email_settings_lease_pair", sql`(${t.leaseOwner} IS NULL) = (${t.leaseUntil} IS NULL)`),
    check("email_settings_pause_pair", sql`(${t.pausedAt} IS NULL) = (${t.pausedReason} IS NULL)`),
    check("email_settings_pause_reason", sql`${t.pausedReason} IS NULL OR ${t.pausedReason} IN ('rejected','failing')`),
    check("email_settings_due_when_on", sql`(${t.cadence} = 'off') = (${t.nextDueAt} IS NULL)`),
    check("email_settings_failures_nonneg", sql`${t.consecutiveFailures} >= 0`),
    check(
      "email_settings_outcome",
      sql`${t.lastOutcome} IS NULL OR ${t.lastOutcome} IN
        ('sent','unavailable','refused','rejected','timed_out','connect_failed','tls_failed','internal')`,
    ),
    index("email_settings_due_idx")
      .on(t.nextDueAt)
      .where(sql`${t.cadence} <> 'off' AND ${t.pausedAt} IS NULL AND ${t.leaseOwner} IS NULL`),
  ],
);

/** One row per person per project: the forward-only mailed-through position (E8). Not project-owned's usual column alone — PK is `(project_id, user_id)`. */
export const emailProjectState = pgTable(
  "email_project_state",
  {
    projectId: uuid("project_id").notNull(),
    userId: uuid("user_id").notNull(),
    mailedSeq: bigint("mailed_seq", { mode: "bigint" }).notNull().default(sql`0`),
    excluded: boolean("excluded").default(false).notNull(),
    sendingSeq: bigint("sending_seq", { mode: "bigint" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.userId] }),
    foreignKey({
      name: "email_project_state_member_fk",
      columns: [t.projectId, t.userId],
      foreignColumns: [member.organizationId, member.userId],
    }).onDelete("cascade"),
    check("email_project_state_mailed_nonneg", sql`${t.mailedSeq} >= 0`),
    check("email_project_state_sending_fwd", sql`${t.sendingSeq} IS NULL OR ${t.sendingSeq} >= ${t.mailedSeq}`),
  ],
);

/** Append-only: no body, no subject, no address, no excerpt, no project column (N60, FR-032). */
export const emailDeliveryAttempts = pgTable(
  "email_delivery_attempts",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id").references(() => user.id, { onDelete: "cascade" }),
    at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
    purpose: text("purpose").notNull(),
    cadence: text("cadence"),
    problemCount: integer("problem_count").default(0).notNull(),
    outcome: text("outcome").notNull(),
    smtpCode: smallint("smtp_code"),
    durationMs: integer("duration_ms").notNull(),
  },
  (t) => [
    check("email_delivery_attempts_purpose", sql`${t.purpose} IN ('problems','invitation','password_reset')`),
    check("email_delivery_attempts_cadence", sql`${t.cadence} IS NULL OR ${t.cadence} IN ('immediate','digest')`),
    check(
      "email_delivery_attempts_outcome",
      sql`${t.outcome} IN ('sent','unavailable','refused','rejected','timed_out','connect_failed','tls_failed','internal')`,
    ),
    check("email_delivery_attempts_cadence_purpose", sql`(${t.purpose} = 'problems') = (${t.cadence} IS NOT NULL)`),
    check("email_delivery_attempts_count_nonneg", sql`${t.problemCount} >= 0`),
    check("email_delivery_attempts_duration_nonneg", sql`${t.durationMs} >= 0`),
    index("email_delivery_attempts_user_idx").on(t.userId, t.at.desc()),
    index("email_delivery_attempts_purge_idx").on(t.at),
  ],
);

export type EmailSettingsRow = typeof emailSettings.$inferSelect;
export type EmailProjectStateRow = typeof emailProjectState.$inferSelect;
export type EmailAttemptRow = typeof emailDeliveryAttempts.$inferSelect;
