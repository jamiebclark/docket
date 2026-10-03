import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { postTargets } from "./posts";
import { projects } from "./projects";

export const publishAttemptOutcome = pgEnum("publish_attempt_outcome", [
  // Provider results
  "continue",
  "done",
  "retryable_error",
  "fatal_error",
  "ambiguous",
  // Engine events
  "deferred",
  "recovered_retry",
  "recovered_ambiguous",
  "stale_result",
  "account_unavailable",
  "did_not_complete",
  "released",
  // User actions
  "resolved_published",
  "resolved_failed",
  "retry_requested",
]);

/** Append-only: the DAL exposes insert and list only (FR-006). */
export const publishAttempts = pgTable(
  "publish_attempts",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    postTargetId: uuid("post_target_id")
      .notNull()
      .references(() => postTargets.id, { onDelete: "cascade" }),
    step: text("step").notNull(),
    outcome: publishAttemptOutcome("outcome").notNull(),
    requestSummary: jsonb("request_summary").default({}).notNull(),
    responseSummary: jsonb("response_summary").default({}).notNull(),
    error: text("error"),
    durationMs: integer("duration_ms"),
    tickId: uuid("tick_id"),
    actorUserId: uuid("actor_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("publish_attempts_target_created_idx").on(t.projectId, t.postTargetId, t.createdAt)],
);

export type PublishAttemptRow = typeof publishAttempts.$inferSelect;
