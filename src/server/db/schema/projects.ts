import { foreignKey, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organization } from "./auth";
import { voiceProfiles } from "./generation";
import { approvalPolicy, schedulingPolicy } from "./policy-enums";

export { approvalPolicy, schedulingPolicy };

/** `id` equals `organization.id` (research D3). */
export const projects = pgTable(
  "projects",
  {
  id: uuid("id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  timezone: text("timezone").notNull(),
  defaultApprovalPolicy: approvalPolicy("default_approval_policy")
    .default("review_required")
    .notNull(),
  defaultSchedulingPolicy: schedulingPolicy("default_scheduling_policy")
    .default("leave_as_draft")
    .notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
  defaultVoiceProfileId: uuid("default_voice_profile_id"),
  },
  (t) => [
    // Profiles are archived, never deleted, so NO ACTION; the project cascade removes both sides together.
    foreignKey({
      name: "projects_default_voice_profile_fk",
      columns: [t.id, t.defaultVoiceProfileId],
      foreignColumns: [voiceProfiles.projectId, voiceProfiles.id],
    }),
  ],
);

export type ProjectRow = typeof projects.$inferSelect;
