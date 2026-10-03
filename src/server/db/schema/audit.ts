import { sql } from "drizzle-orm";
import { index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { projects } from "./projects";

export const membershipAction = pgEnum("membership_action", [
  "invite",
  "invite_regenerate",
  "invite_revoke",
  "invite_accept",
  "invite_decline",
  "member_remove",
  "member_leave",
  "role_change",
  "ownership_transfer",
]);

/** Append-only: the DAL exposes insert and list only (FR-033). */
export const membershipAuditLog = pgTable(
  "membership_audit_log",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id").references(() => user.id, { onDelete: "set null" }),
    action: membershipAction("action").notNull(),
    subjectUserId: uuid("subject_user_id").references(() => user.id, { onDelete: "set null" }),
    subjectEmail: text("subject_email"),
    details: jsonb("details").default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("membership_audit_log_project_created_idx").on(t.projectId, t.createdAt.desc())],
);
