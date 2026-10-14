import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
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

export const standingSeriesPeriod = pgEnum("standing_series_period", ["day", "week", "month", "date"]);
export const standingSeriesMediaSource = pgEnum("standing_series_media_source", ["none", "pool", "generate"]);
export const standingSeriesPositionStatus = pgEnum("standing_series_position_status", [
  "queued",
  "running",
  "produced",
  "failed",
  "skipped",
  "missed",
]);
export const standingSeriesOccurrenceRule = pgEnum("standing_series_occurrence_rule", ["cadence", "dated_list"]);
export const standingSeriesOccurrenceOutcome = pgEnum("standing_series_occurrence_outcome", [
  "produced",
  "failed",
  "skipped",
  "missed",
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
    occurrenceRule: standingSeriesOccurrenceRule("occurrence_rule").notNull().default("cadence"),
    leadDays: smallint("lead_days").notNull().default(0),
    listVersion: integer("list_version").notNull().default(0),
    lastImportAt: timestamp("last_import_at", { withTimezone: true }),
    lastImportFilename: text("last_import_filename"),
    lastImportRowCount: smallint("last_import_row_count"),
    lastImportProblems: jsonb("last_import_problems"),
    cadenceCount: smallint("cadence_count"),
    cadencePeriod: standingSeriesPeriod("cadence_period"),
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
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
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
    check(
      "standing_series_cadence_count_range",
      sql`${t.cadenceCount} IS NULL OR ${t.cadenceCount} BETWEEN 1 AND 10`,
    ),
    check("standing_series_lead_days_range", sql`${t.leadDays} BETWEEN 0 AND 30`),
    check(
      "standing_series_cadence_count_pair",
      sql`(${t.occurrenceRule} = 'cadence') = (${t.cadenceCount} IS NOT NULL)`,
    ),
    check(
      "standing_series_cadence_period_pair",
      sql`(${t.occurrenceRule} = 'cadence') = (${t.cadencePeriod} IS NOT NULL) AND ${t.cadencePeriod} IS DISTINCT FROM 'date'`,
    ),
    check(
      "standing_series_next_run_at_pair",
      sql`(${t.occurrenceRule} = 'cadence') = (${t.nextRunAt} IS NOT NULL)`,
    ),
    check(
      "standing_series_last_import_filename_pair",
      sql`(${t.lastImportAt} IS NULL) = (${t.lastImportFilename} IS NULL)`,
    ),
    check(
      "standing_series_last_import_requires_dated",
      sql`${t.lastImportAt} IS NULL OR ${t.occurrenceRule} = 'dated_list'`,
    ),
    check(
      "standing_series_lead_days_requires_dated",
      sql`${t.occurrenceRule} = 'dated_list' OR ${t.leadDays} = 0`,
    ),
    check(
      "standing_series_template_fields_requires_dated",
      sql`${t.occurrenceRule} = 'dated_list' OR cardinality(${t.templateFields}) = 0`,
    ),
    check(
      "standing_series_last_import_filename_len",
      sql`${t.lastImportFilename} IS NULL OR char_length(${t.lastImportFilename}) BETWEEN 1 AND 255`,
    ),
    check("standing_series_last_import_row_count_nonneg", sql`${t.lastImportRowCount} IS NULL OR ${t.lastImportRowCount} >= 0`),
    check(
      "standing_series_last_import_problems_shape",
      sql`${t.lastImportProblems} IS NULL OR (jsonb_typeof(${t.lastImportProblems}) = 'array' AND jsonb_array_length(${t.lastImportProblems}) <= 100)`,
    ),
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
    check("standing_series_runs_dated_has_no_plan", sql`${t.period} <> 'date' OR ${t.plan} IS NULL`),
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
    dated: jsonb("dated"),
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
    check("standing_series_positions_dated_shape", sql`${t.dated} IS NULL OR jsonb_typeof(${t.dated}) = 'object'`),
    index("standing_series_positions_due_idx").on(t.runId, t.position).where(sql`${t.status} = 'queued'`),
    index("standing_series_positions_counts_idx").on(t.projectId, t.runId, t.status),
  ],
);

export const standingSeriesDatedRows = pgTable(
  "standing_series_dated_rows",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    seriesId: uuid("series_id").notNull(),
    ordinal: smallint("ordinal").notNull(),
    month: smallint("month").notNull(),
    day: smallint("day").notNull(),
    year: smallint("year"),
    keyValue: text("key_value").notNull(),
    fields: jsonb("fields").notNull(),
    mediaFilename: text("media_filename"),
    mediaAssetId: uuid("media_asset_id").references(() => mediaAssets.id, { onDelete: "set null" }),
    nextTargetDate: date("next_target_date", { mode: "string" }),
    sourceLine: integer("source_line"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [
    unique("standing_series_dated_rows_project_id_uq").on(t.projectId, t.id),
    unique("standing_series_dated_rows_series_ordinal_uq").on(t.seriesId, t.ordinal),
    foreignKey({
      name: "standing_series_dated_rows_series_fk",
      columns: [t.projectId, t.seriesId],
      foreignColumns: [standingSeries.projectId, standingSeries.id],
    }).onDelete("cascade"),
    uniqueIndex("standing_series_dated_rows_identity_uq").on(
      t.seriesId,
      t.month,
      t.day,
      sql`coalesce(${t.year}, 0)`,
      sql`lower(btrim(${t.keyValue}))`,
    ),
    check("standing_series_dated_rows_month_range", sql`${t.month} BETWEEN 1 AND 12`),
    check(
      "standing_series_dated_rows_day_range",
      sql`${t.day} >= 1 AND ${t.day} <= CASE ${t.month}
          WHEN 2 THEN 29
          WHEN 4 THEN 30 WHEN 6 THEN 30 WHEN 9 THEN 30 WHEN 11 THEN 30
          ELSE 31 END`,
    ),
    check("standing_series_dated_rows_year_range", sql`${t.year} IS NULL OR ${t.year} BETWEEN 1 AND 9999`),
    check(
      "standing_series_dated_rows_leap_year",
      sql`${t.year} IS NULL OR ${t.month} <> 2 OR ${t.day} <> 29
       OR (${t.year} % 4 = 0 AND (${t.year} % 100 <> 0 OR ${t.year} % 400 = 0))`,
    ),
    check("standing_series_dated_rows_key_value_len", sql`btrim(${t.keyValue}) <> '' AND char_length(${t.keyValue}) <= 500`),
    check("standing_series_dated_rows_fields_shape", sql`jsonb_typeof(${t.fields}) = 'object'`),
    check(
      "standing_series_dated_rows_media_filename_len",
      sql`${t.mediaFilename} IS NULL OR char_length(${t.mediaFilename}) BETWEEN 1 AND 255`,
    ),
    check(
      "standing_series_dated_rows_next_target_year",
      sql`${t.nextTargetDate} IS NULL OR ${t.year} IS NULL
       OR extract(year from ${t.nextTargetDate}) = ${t.year}`,
    ),
    index("standing_series_dated_rows_due_idx")
      .on(t.seriesId, t.nextTargetDate)
      .where(sql`${t.nextTargetDate} IS NOT NULL`),
    index("standing_series_dated_rows_list_idx").on(t.projectId, t.seriesId, t.ordinal),
  ],
);

export const standingSeriesOccurrences = pgTable(
  "standing_series_occurrences",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    seriesId: uuid("series_id").notNull(),
    rowId: uuid("row_id").notNull(),
    year: smallint("year").notNull(),
    targetDate: date("target_date", { mode: "string" }).notNull(),
    outcome: standingSeriesOccurrenceOutcome("outcome"),
    positionId: uuid("position_id"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).defaultNow().notNull(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (t) => [
    unique("standing_series_occurrences_project_id_uq").on(t.projectId, t.id),
    unique("standing_series_occurrences_row_year_uq").on(t.rowId, t.year),
    foreignKey({
      name: "standing_series_occurrences_series_fk",
      columns: [t.projectId, t.seriesId],
      foreignColumns: [standingSeries.projectId, standingSeries.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "standing_series_occurrences_row_fk",
      columns: [t.projectId, t.rowId],
      foreignColumns: [standingSeriesDatedRows.projectId, standingSeriesDatedRows.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "standing_series_occurrences_position_fk",
      columns: [t.projectId, t.positionId],
      foreignColumns: [standingSeriesPositions.projectId, standingSeriesPositions.id],
    }).onDelete("set null"),
    check("standing_series_occurrences_year_match", sql`extract(year from ${t.targetDate}) = ${t.year}`),
    check("standing_series_occurrences_missed_no_position", sql`${t.outcome} <> 'missed' OR ${t.positionId} IS NULL`),
    check("standing_series_occurrences_pending_has_position", sql`${t.outcome} IS NOT NULL OR ${t.positionId} IS NOT NULL`),
    check("standing_series_occurrences_settled_pair", sql`(${t.outcome} IS NULL) = (${t.settledAt} IS NULL)`),
    index("standing_series_occurrences_series_idx").on(t.projectId, t.seriesId, t.targetDate.desc()),
    index("standing_series_occurrences_row_idx").on(t.projectId, t.rowId, t.year.desc()),
    index("standing_series_occurrences_prune_idx").on(t.recordedAt).where(sql`${t.outcome} IS NOT NULL`),
  ],
);

export type StandingSeriesRow = typeof standingSeries.$inferSelect;
export type StandingSeriesRunRow = typeof standingSeriesRuns.$inferSelect;
export type StandingSeriesPositionRow = typeof standingSeriesPositions.$inferSelect;
export type StandingSeriesDatedRowRow = typeof standingSeriesDatedRows.$inferSelect;
export type StandingSeriesOccurrenceRow = typeof standingSeriesOccurrences.$inferSelect;
