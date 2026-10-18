import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, smallint, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { postTargets } from "./posts";
import { projects } from "./projects";
import { socialAccounts } from "./accounts";

/** One reading of one target's numbers (data-model.md §1). Append-only is a property of the DAL, not a trigger. */
export const postMetricSnapshots = pgTable(
  "post_metric_snapshots",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    postTargetId: uuid("post_target_id")
      .notNull()
      .references(() => postTargets.id, { onDelete: "cascade" }),
    socialAccountId: uuid("social_account_id")
      .notNull()
      .references(() => socialAccounts.id, { onDelete: "cascade" }),
    providerKey: text("provider_key").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    metrics: jsonb("metrics").default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique("post_metric_snapshots_subject_uq").on(t.projectId, t.postTargetId, t.capturedAt),
    check("post_metric_snapshots_captured_at_ms", sql`${t.capturedAt} = date_trunc('milliseconds', ${t.capturedAt})`),
    check("post_metric_snapshots_metrics_size", sql`octet_length(${t.metrics}::text) <= 2000`),
    check("post_metric_snapshots_metrics_object", sql`jsonb_typeof(${t.metrics}) = 'object'`),
    check("post_metric_snapshots_provider_key_len", sql`char_length(${t.providerKey}) BETWEEN 1 AND 50`),
    index("post_metric_snapshots_latest_idx").on(t.projectId, t.postTargetId, t.capturedAt.desc()),
    index("post_metric_snapshots_window_idx").on(t.socialAccountId, t.capturedAt),
    index("post_metric_snapshots_captured_idx").on(t.capturedAt),
  ],
);

export type PostMetricSnapshotRow = typeof postMetricSnapshots.$inferSelect;
export type NewPostMetricSnapshot = typeof postMetricSnapshots.$inferInsert;

/** One reading of one account's numbers (data-model.md §2). */
export const accountMetricSnapshots = pgTable(
  "account_metric_snapshots",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    socialAccountId: uuid("social_account_id")
      .notNull()
      .references(() => socialAccounts.id, { onDelete: "cascade" }),
    providerKey: text("provider_key").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    metrics: jsonb("metrics").default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique("account_metric_snapshots_subject_uq").on(t.projectId, t.socialAccountId, t.capturedAt),
    check("account_metric_snapshots_captured_at_ms", sql`${t.capturedAt} = date_trunc('milliseconds', ${t.capturedAt})`),
    check("account_metric_snapshots_metrics_size", sql`octet_length(${t.metrics}::text) <= 2000`),
    check("account_metric_snapshots_metrics_object", sql`jsonb_typeof(${t.metrics}) = 'object'`),
    check("account_metric_snapshots_provider_key_len", sql`char_length(${t.providerKey}) BETWEEN 1 AND 50`),
    index("account_metric_snapshots_latest_idx").on(t.projectId, t.socialAccountId, t.capturedAt.desc()),
    index("account_metric_snapshots_window_idx").on(t.socialAccountId, t.capturedAt),
    index("account_metric_snapshots_captured_idx").on(t.capturedAt),
  ],
);

export type AccountMetricSnapshotRow = typeof accountMetricSnapshots.$inferSelect;
export type NewAccountMetricSnapshot = typeof accountMetricSnapshots.$inferInsert;

/** One row per eligible published target (data-model.md §3). Lazily created inside the claim. */
export const postMetricPollStates = pgTable(
  "post_metric_poll_states",
  {
    postTargetId: uuid("post_target_id")
      .primaryKey()
      .references(() => postTargets.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    socialAccountId: uuid("social_account_id")
      .notNull()
      .references(() => socialAccounts.id, { onDelete: "cascade" }),
    nextPollAt: timestamp("next_poll_at", { withTimezone: true }),
    pollLeaseUntil: timestamp("poll_lease_until", { withTimezone: true }),
    pollLeaseOwner: uuid("poll_lease_owner"),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    lastCapturedAt: timestamp("last_captured_at", { withTimezone: true }),
    consecutiveFailures: smallint("consecutive_failures").default(0).notNull(),
    lastError: text("last_error"),
    failingSince: timestamp("failing_since", { withTimezone: true }),
    frozenAt: timestamp("frozen_at", { withTimezone: true }),
    frozenReason: text("frozen_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    check("post_metric_poll_states_lease_pair", sql`(${t.pollLeaseUntil} IS NULL) = (${t.pollLeaseOwner} IS NULL)`),
    check("post_metric_poll_states_failures_nonneg", sql`${t.consecutiveFailures} >= 0`),
    check("post_metric_poll_states_frozen_pair", sql`(${t.frozenAt} IS NULL) = (${t.frozenReason} IS NULL)`),
    check("post_metric_poll_states_frozen_reason_enum", sql`${t.frozenReason} IS NULL OR ${t.frozenReason} IN ('settled', 'gone')`),
    check("post_metric_poll_states_frozen_has_no_next", sql`${t.frozenAt} IS NULL OR ${t.nextPollAt} IS NULL`),
    check("post_metric_poll_states_failing_pair", sql`(${t.consecutiveFailures} = 0) = (${t.failingSince} IS NULL)`),
    check("post_metric_poll_states_last_error_len", sql`${t.lastError} IS NULL OR char_length(${t.lastError}) <= 500`),
    index("post_metric_poll_states_claim_idx")
      .on(t.nextPollAt, t.postTargetId)
      .where(sql`${t.pollLeaseUntil} IS NULL AND ${t.nextPollAt} IS NOT NULL`),
  ],
);

export type PostMetricPollStateRow = typeof postMetricPollStates.$inferSelect;
export type NewPostMetricPollState = typeof postMetricPollStates.$inferInsert;

/** One row per eligible account (data-model.md §4). An account never freezes. */
export const accountMetricPollStates = pgTable(
  "account_metric_poll_states",
  {
    socialAccountId: uuid("social_account_id")
      .primaryKey()
      .references(() => socialAccounts.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    nextPollAt: timestamp("next_poll_at", { withTimezone: true }),
    pollLeaseUntil: timestamp("poll_lease_until", { withTimezone: true }),
    pollLeaseOwner: uuid("poll_lease_owner"),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    lastCapturedAt: timestamp("last_captured_at", { withTimezone: true }),
    consecutiveFailures: smallint("consecutive_failures").default(0).notNull(),
    lastError: text("last_error"),
    failingSince: timestamp("failing_since", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    check("account_metric_poll_states_lease_pair", sql`(${t.pollLeaseUntil} IS NULL) = (${t.pollLeaseOwner} IS NULL)`),
    check("account_metric_poll_states_failures_nonneg", sql`${t.consecutiveFailures} >= 0`),
    check("account_metric_poll_states_failing_pair", sql`(${t.consecutiveFailures} = 0) = (${t.failingSince} IS NULL)`),
    check("account_metric_poll_states_last_error_len", sql`${t.lastError} IS NULL OR char_length(${t.lastError}) <= 500`),
    index("account_metric_poll_states_claim_idx")
      .on(t.nextPollAt, t.socialAccountId)
      .where(sql`${t.pollLeaseUntil} IS NULL AND ${t.nextPollAt} IS NOT NULL`),
  ],
);

export type AccountMetricPollStateRow = typeof accountMetricPollStates.$inferSelect;
export type NewAccountMetricPollState = typeof accountMetricPollStates.$inferInsert;
