import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { session, user } from "./auth";
import { projects } from "./projects";

/** Short-lived, single-use OAuth connect attempt (or token paste), bound to one user, session and project. */
export const connectAttempts = pgTable(
  "connect_attempts",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => session.id, { onDelete: "cascade" }),
    groupKey: text("group_key").notNull(),
    /** Hex SHA-256 of the 32-byte state. The state itself is never stored. */
    stateHash: text("state_hash").notNull().unique("connect_attempts_state_hash_uq"),
    /** `enc:v1:…` of the JSON candidates, AAD `connect_attempt:<id>`. Null before the exchange and after completion. */
    candidatesEncrypted: text("candidates_encrypted"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    callbackAt: timestamp("callback_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("connect_attempts_expires_idx").on(t.expiresAt),
    check("connect_attempts_completed_after_callback", sql`${t.completedAt} is null or ${t.callbackAt} is not null`),
    check(
      "connect_attempts_candidates_after_callback",
      sql`${t.candidatesEncrypted} is null or ${t.callbackAt} is not null`,
    ),
    check("connect_attempts_group_key_format", sql`${t.groupKey} ~ '^[a-z0-9-]+$'`),
  ],
);
