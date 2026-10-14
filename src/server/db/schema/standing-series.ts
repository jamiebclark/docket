import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { voiceProfiles } from "./generation";
import { generationJobItemError } from "./jobs";
import { mediaAssets } from "./media";
import { approvalPolicy, schedulingPolicy } from "./policy-enums";
import { projects } from "./projects";

export const standingSeriesPeriod = pgEnum("standing_series_period", ["day", "week", "month"]);
export const standingSeriesMediaSource = pgEnum("standing_series_media_source", ["none", "pool", "generate"]);
export const standingSeriesPositionStatus = pgEnum("standing_series_position_status", [
  "queued",
  "running",
  "produced",
  "failed",
  "skipped",
]);
export const standingSeriesOutcome = pgEnum("standing_series_outcome", [
  "produced_all",
  "produced_some",
  "produced_none",
  "incomplete",
]);
export const standingSeriesSkipReason = pgEnum("standing_series_skip_reason", [
  "pool_exhausted",
  "image_generation_not_configured",
  "image_generation_failed",
  "media_unusable",
  "media_storage_not_configured",
  "series_not_runnable",
]);
export const standingSeriesBlockReason = pgEnum("standing_series_block_reason", [
  "voice_profile_missing",
  "no_usable_target",
]);
export const standingSeriesPauseReason = pgEnum("standing_series_pause_reason", ["no_output"]);

export const standingSeries = pgTable(
  "standing_series",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    brief: text("brief").notNull(),
    template: text("template").notNull(),
    templateFields: text("template_fields").array().notNull().default(sql`'{}'::text[]`),
    voiceProfileId: uuid("voice_profile_id").notNull(),
    targetAccountIds: uuid("target_account_ids").array().notNull(),
    cadenceCount: smallint("cadence_count").notNull(),
    cadencePeriod: standingSeriesPeriod("cadence_period").notNull(),
    mediaSource: standingSeriesMediaSource("media_source").notNull(),
    mediaPoolTag: text("media_pool_tag"),
    imagePrompt: text("image_prompt"),
    requestedApproval: approvalPolicy("requested_approval"),
    requestedScheduling: schedulingPolicy("requested_scheduling"),
    approvalPolicy: approvalPolicy("approval_policy").notNull(),
    schedulingPolicy: schedulingPolicy("scheduling_policy").notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    autoPausedReason: standingSeriesPauseReason("auto_paused_reason"),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
    leaseOwner: uuid("lease_owner"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    lastClaimedAt: timestamp("last_claimed_at", { withTimezone: true }),
    createdByUserId: uuid("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [
    unique("standing_series_project_id_uq").on(t.projectId, t.id),
    uniqueIndex("standing_series_project_name_uq").on(t.projectId, sql`lower(${t.name})`),
    foreignKey({
      name: "standing_series_voice_profile_fk",
      columns: [t.projectId, t.voiceProfileId],
      foreignColumns: [voiceProfiles.projectId, voiceProfiles.id],
    }),
    check("standing_series_name_len", sql`char_length(${t.name}) BETWEEN 1 AND 100 AND btrim(${t.name}) = ${t.name}`),
    check("standing_series_brief_len", sql`char_length(${t.brief}) BETWEEN 1 AND 2000`),
    check("standing_series_template_len", sql`char_length(${t.template}) BETWEEN 1 AND 2000`),
    check("standing_series_targets_card", sql`cardinality(${t.targetAccountIds}) BETWEEN 1 AND 50`),
    check("standing_series_cadence_count_range", sql`${t.cadenceCount} BETWEEN 1 AND 10`),
    check(
      "standing_series_pool_tag_only_for_pool",
      sql`${t.mediaPoolTag} IS NULL OR ${t.mediaSource} = 'pool'`,
    ),
    check(
      "standing_series_image_prompt_pair",
      sql`(${t.mediaSource} = 'generate') = (${t.imagePrompt} IS NOT NULL)`,
    ),
    check(
      "standing_series_image_prompt_len",
      sql`${t.imagePrompt} IS NULL OR char_length(${t.imagePrompt}) BETWEEN 1 AND 1000`,
    ),
    check("standing_series_lease_pair", sql`(${t.leaseUntil} IS NULL) = (${t.leaseOwner} IS NULL)`),
    check(
      "standing_series_auto_pause_implies_disabled",
      sql`${t.autoPausedReason} IS NULL OR ${t.enabled} = false`,
    ),
    index("standing_series_claim_idx")
      .on(t.nextRunAt, sql`${t.lastClaimedAt} NULLS FIRST`, t.id)
      .where(sql`${t.enabled}`),
    index("standing_series_project_name_idx").on(t.projectId, sql`lower(${t.name})`),
  ],
);

export const standingSeriesRuns = pgTable(
  "standing_series_runs",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    seriesId: uuid("series_id").notNull(),
    period: standingSeriesPeriod("period").notNull(),
    periodStart: date("period_start", { mode: "string" }).notNull(),
    periodStartAt: timestamp("period_start_at", { withTimezone: true }).notNull(),
    requestedCount: smallint("requested_count").notNull(),
    config: jsonb("config").notNull(),
    plan: jsonb("plan"),
    planAttemptCount: smallint("plan_attempt_count").default(0).notNull(),
    planNextAttemptAt: timestamp("plan_next_attempt_at", { withTimezone: true }),
    missedPeriods: smallint("missed_periods").default(0).notNull(),
    droppedAccountIds: uuid("dropped_account_ids").array().notNull().default(sql`'{}'::uuid[]`),
    blockedReason: standingSeriesBlockReason("blocked_reason"),
    outcome: standingSeriesOutcome("outcome"),
    openedAt: timestamp("opened_at", { withTimezone: true }).defaultNow().notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => [
    unique("standing_series_runs_project_id_uq").on(t.projectId, t.id),
    unique("standing_series_runs_period_uq").on(t.seriesId, t.period, t.periodStart),
    uniqueIndex("standing_series_runs_open_uq").on(t.seriesId).where(sql`${t.closedAt} IS NULL`),
    foreignKey({
      name: "standing_series_runs_series_fk",
      columns: [t.projectId, t.seriesId],
      foreignColumns: [standingSeries.projectId, standingSeries.id],
    }).onDelete("cascade"),
    check("standing_series_runs_requested_count_range", sql`${t.requestedCount} BETWEEN 1 AND 10`),
    check("standing_series_runs_closed_pair", sql`(${t.closedAt} IS NULL) = (${t.outcome} IS NULL)`),
    check("standing_series_runs_single_post_has_no_plan", sql`${t.requestedCount} > 1 OR ${t.plan} IS NULL`),
    check("standing_series_runs_missed_nonneg", sql`${t.missedPeriods} >= 0`),
    check("standing_series_runs_plan_attempts_nonneg", sql`${t.planAttemptCount} >= 0`),
    index("standing_series_runs_series_recent_idx").on(t.projectId, t.seriesId, t.openedAt.desc()),
    index("standing_series_runs_closed_idx").on(t.closedAt).where(sql`${t.closedAt} IS NOT NULL`),
  ],
);

export const standingSeriesPositions = pgTable(
  "standing_series_positions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull(),
    position: smallint("position").notNull(),
    status: standingSeriesPositionStatus("status").default("queued").notNull(),
    mediaAssetId: uuid("media_asset_id").references(() => mediaAssets.id, { onDelete: "restrict" }),
    attemptCount: smallint("attempt_count").default(0).notNull(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow().notNull(),
    pendingRetry: jsonb("pending_retry"),
    lastErrorKind: generationJobItemError("last_error_kind"),
    lastError: text("last_error"),
    skipReason: standingSeriesSkipReason("skip_reason"),
    skipAccountId: uuid("skip_account_id"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [
    unique("standing_series_positions_project_id_uq").on(t.projectId, t.id),
    unique("standing_series_positions_run_position_uq").on(t.runId, t.position),
    foreignKey({
      name: "standing_series_positions_run_fk",
      columns: [t.projectId, t.runId],
      foreignColumns: [standingSeriesRuns.projectId, standingSeriesRuns.id],
    }).onDelete("cascade"),
    uniqueIndex("standing_series_positions_active_media_uq")
      .on(t.projectId, t.mediaAssetId)
      .where(sql`${t.mediaAssetId} IS NOT NULL AND ${t.status} IN ('queued','running')`),
    check("standing_series_positions_position_nonneg", sql`${t.position} >= 0`),
    check("standing_series_positions_last_error_len", sql`${t.lastError} IS NULL OR char_length(${t.lastError}) <= 500`),
    check("standing_series_positions_skip_pair", sql`(${t.status} = 'skipped') = (${t.skipReason} IS NOT NULL)`),
    check(
      "standing_series_positions_skip_account_needs_reason",
      sql`${t.skipAccountId} IS NULL OR ${t.skipReason} IS NOT NULL`,
    ),
    check("standing_series_positions_failed_has_kind", sql`${t.status} <> 'failed' OR ${t.lastErrorKind} IS NOT NULL`),
    check(
      "standing_series_positions_pending_retry_state",
      sql`${t.pendingRetry} IS NULL OR ${t.status} IN ('queued','running')`,
    ),
    index("standing_series_positions_due_idx").on(t.runId, t.position).where(sql`${t.status} = 'queued'`),
    index("standing_series_positions_counts_idx").on(t.projectId, t.runId, t.status),
  ],
);

export type StandingSeriesRow = typeof standingSeries.$inferSelect;
export type StandingSeriesRunRow = typeof standingSeriesRuns.$inferSelect;
export type StandingSeriesPositionRow = typeof standingSeriesPositions.$inferSelect;
