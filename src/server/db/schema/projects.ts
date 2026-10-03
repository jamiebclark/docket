import { pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organization } from "./auth";

export const approvalPolicy = pgEnum("approval_policy", ["review_required", "auto_approve"]);
export const schedulingPolicy = pgEnum("scheduling_policy", ["leave_as_draft", "add_to_queue"]);

/** `id` equals `organization.id` (research D3). */
export const projects = pgTable("projects", {
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
});

export type ProjectRow = typeof projects.$inferSelect;
