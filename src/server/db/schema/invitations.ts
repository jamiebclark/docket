import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { invitation, user } from "./auth";
import { projects } from "./projects";

export const invitationTokens = pgTable(
  "invitation_tokens",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    invitationId: uuid("invitation_id")
      .notNull()
      .references(() => invitation.id, { onDelete: "cascade" }),
    /** Hex SHA-256 of the 32-byte token (research D6). */
    tokenHash: text("token_hash").notNull().unique(),
    createdBy: uuid("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    index("invitation_tokens_invitation_id_idx").on(t.invitationId),
    uniqueIndex("invitation_tokens_active_uidx")
      .on(t.invitationId)
      .where(sql`${t.usedAt} is null and ${t.revokedAt} is null`),
  ],
);
