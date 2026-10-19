import { sql } from "drizzle-orm";
import {
  check,
  doublePrecision,
  date,
  index,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { postTargets } from "./posts";
import { projects } from "./projects";
import { socialAccounts } from "./accounts";

/** A rollup point's provenance at fold time (data-model.md §1). */
export const metricKind = pgEnum("metric_kind", ["cumulative", "windowed", "unknown"]);

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
    /** A run-time `{ kind: "unavailable" }` read result, kept honest for the panel (FR-050). */
    unavailableReason: text("unavailable_reason"),
    unavailableDocsPath: text("unavailable_docs_path"),
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
    check("post_metric_poll_states_frozen_reason_enum", sql`${t.frozenReason} IS NULL OR ${t.frozenReason} IN ('settled', 'gone', 'expired', 'unqueryable')`),
    check("post_metric_poll_states_frozen_has_no_next", sql`${t.frozenAt} IS NULL OR ${t.nextPollAt} IS NULL`),
    check("post_metric_poll_states_failing_pair", sql`(${t.consecutiveFailures} = 0) = (${t.failingSince} IS NULL)`),
    check("post_metric_poll_states_last_error_len", sql`${t.lastError} IS NULL OR char_length(${t.lastError}) <= 500`),
    check(
      "post_metric_poll_states_unavailable_reason_len",
      sql`${t.unavailableReason} IS NULL OR char_length(${t.unavailableReason}) <= 500`,
    ),
    check(
      "post_metric_poll_states_unavailable_docs_pair",
      sql`${t.unavailableDocsPath} IS NULL OR ${t.unavailableReason} IS NOT NULL`,
    ),
    check(
      "post_metric_poll_states_unavailable_docs_path_len",
      sql`${t.unavailableDocsPath} IS NULL OR char_length(${t.unavailableDocsPath}) <= 100`,
    ),
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
    /** A run-time `{ kind: "unavailable" }` read result, kept honest for the panel (FR-050). */
    unavailableReason: text("unavailable_reason"),
    unavailableDocsPath: text("unavailable_docs_path"),
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
    check(
      "account_metric_poll_states_unavailable_reason_len",
      sql`${t.unavailableReason} IS NULL OR char_length(${t.unavailableReason}) <= 500`,
    ),
    check(
      "account_metric_poll_states_unavailable_docs_pair",
      sql`${t.unavailableDocsPath} IS NULL OR ${t.unavailableReason} IS NOT NULL`,
    ),
    check(
      "account_metric_poll_states_unavailable_docs_path_len",
      sql`${t.unavailableDocsPath} IS NULL OR char_length(${t.unavailableDocsPath}) <= 100`,
    ),
    index("account_metric_poll_states_claim_idx")
      .on(t.nextPollAt, t.socialAccountId)
      .where(sql`${t.pollLeaseUntil} IS NULL AND ${t.nextPollAt} IS NOT NULL`),
  ],
);

export type AccountMetricPollStateRow = typeof accountMetricPollStates.$inferSelect;
export type NewAccountMetricPollState = typeof accountMetricPollStates.$inferInsert;

/** One durable point per account, per metric key, per UTC day (data-model.md §2). Never pruned. */
export const accountMetricRollups = pgTable(
  "account_metric_rollups",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    socialAccountId: uuid("social_account_id")
      .notNull()
      .references(() => socialAccounts.id, { onDelete: "cascade" }),
    providerKey: text("provider_key").notNull(),
    metricKey: text("metric_key").notNull(),
    capturedDay: date("captured_day").notNull(),
    value: doublePrecision("value").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    kind: metricKind("kind").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique("account_metric_rollups_subject_uq").on(t.projectId, t.socialAccountId, t.metricKey, t.capturedDay),
    check("account_metric_rollups_provider_key_len", sql`char_length(${t.providerKey}) BETWEEN 1 AND 50`),
    check("account_metric_rollups_metric_key_len", sql`char_length(${t.metricKey}) BETWEEN 1 AND 100`),
    check("account_metric_rollups_captured_at_ms", sql`${t.capturedAt} = date_trunc('milliseconds', ${t.capturedAt})`),
    index("account_metric_rollups_range_idx").on(t.projectId, t.socialAccountId, t.capturedDay),
  ],
);

export type AccountMetricRollupRow = typeof accountMetricRollups.$inferSelect;
export type NewAccountMetricRollup = typeof accountMetricRollups.$inferInsert;

/** One durable point per post target, per metric key, per UTC day (data-model.md §3). Never pruned. */
export const postMetricRollups = pgTable(
  "post_metric_rollups",
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
    metricKey: text("metric_key").notNull(),
    capturedDay: date("captured_day").notNull(),
    value: doublePrecision("value").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    kind: metricKind("kind").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique("post_metric_rollups_subject_uq").on(t.projectId, t.postTargetId, t.metricKey, t.capturedDay),
    check("post_metric_rollups_provider_key_len", sql`char_length(${t.providerKey}) BETWEEN 1 AND 50`),
    check("post_metric_rollups_metric_key_len", sql`char_length(${t.metricKey}) BETWEEN 1 AND 100`),
    check("post_metric_rollups_captured_at_ms", sql`${t.capturedAt} = date_trunc('milliseconds', ${t.capturedAt})`),
    index("post_metric_rollups_latest_idx").on(t.projectId, t.postTargetId, t.capturedDay.desc()),
    index("post_metric_rollups_account_range_idx").on(t.projectId, t.socialAccountId, t.capturedDay),
  ],
);

export type PostMetricRollupRow = typeof postMetricRollups.$inferSelect;
export type NewPostMetricRollup = typeof postMetricRollups.$inferInsert;

/** One row per published target, written once per fact and never rewritten (data-model.md §4). */
export const targetFirstEngagement = pgTable(
  "target_first_engagement",
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
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    exactFirstAt: timestamp("exact_first_at", { withTimezone: true }),
    boundBeforeAt: timestamp("bound_before_at", { withTimezone: true }),
    boundAfterAt: timestamp("bound_after_at", { withTimezone: true }),
    scannedThrough: timestamp("scanned_through", { withTimezone: true }),
    firstRecordedAt: timestamp("first_recorded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    check("target_first_engagement_exact_after_published", sql`${t.exactFirstAt} IS NULL OR ${t.exactFirstAt} >= ${t.publishedAt}`),
    check("target_first_engagement_bound_before_after_published", sql`${t.boundBeforeAt} IS NULL OR ${t.boundBeforeAt} > ${t.publishedAt}`),
    check("target_first_engagement_bound_after_needs_before", sql`${t.boundAfterAt} IS NULL OR ${t.boundBeforeAt} IS NOT NULL`),
    check("target_first_engagement_bound_after_before_before", sql`${t.boundAfterAt} IS NULL OR ${t.boundAfterAt} < ${t.boundBeforeAt}`),
    check("target_first_engagement_bound_after_after_published", sql`${t.boundAfterAt} IS NULL OR ${t.boundAfterAt} >= ${t.publishedAt}`),
    check(
      "target_first_engagement_first_recorded_pair",
      sql`(${t.firstRecordedAt} IS NULL) = (${t.exactFirstAt} IS NULL AND ${t.boundBeforeAt} IS NULL)`,
    ),
    check("target_first_engagement_published_at_ms", sql`${t.publishedAt} = date_trunc('milliseconds', ${t.publishedAt})`),
    check("target_first_engagement_exact_first_at_ms", sql`${t.exactFirstAt} IS NULL OR ${t.exactFirstAt} = date_trunc('milliseconds', ${t.exactFirstAt})`),
    check("target_first_engagement_bound_before_at_ms", sql`${t.boundBeforeAt} IS NULL OR ${t.boundBeforeAt} = date_trunc('milliseconds', ${t.boundBeforeAt})`),
    check("target_first_engagement_bound_after_at_ms", sql`${t.boundAfterAt} IS NULL OR ${t.boundAfterAt} = date_trunc('milliseconds', ${t.boundAfterAt})`),
    check("target_first_engagement_scanned_through_ms", sql`${t.scannedThrough} IS NULL OR ${t.scannedThrough} = date_trunc('milliseconds', ${t.scannedThrough})`),
    check("target_first_engagement_first_recorded_at_ms", sql`${t.firstRecordedAt} IS NULL OR ${t.firstRecordedAt} = date_trunc('milliseconds', ${t.firstRecordedAt})`),
    index("target_first_engagement_account_idx").on(t.projectId, t.socialAccountId),
  ],
);

export type TargetFirstEngagementRow = typeof targetFirstEngagement.$inferSelect;
export type NewTargetFirstEngagement = typeof targetFirstEngagement.$inferInsert;
