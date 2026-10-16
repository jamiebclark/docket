import { sql } from "drizzle-orm";
import {
  boolean,
  check,
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
  foreignKey,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { generationJobItems, generationJobs } from "./jobs";
import { posts } from "./posts";
import { projects } from "./projects";
import { standingSeriesRuns } from "./standing-series";

export const generationMode = pgEnum("generation_mode", [
  "single",
  "series_plan",
  "series_post",
  "regenerate",
  "standing_series_plan",
  "standing_series_post",
]);
export const llmFailureKind = pgEnum("llm_failure_kind", [
  "invalid_output",
  "refused",
  "incomplete",
  "timeout",
  "rate_limited",
  "unavailable",
  "auth",
  "bad_request",
  "credit_exhausted",
]);

/**
 * System-wide (not project-owned): at most one row per credential owner that is currently refusing on
 * billing. Records that an owner is refusing, never which credential refused — no key, hash or prefix
 * (FR-020, C8). Read and written only through src/server/dal/credit-holds.ts (FR-030).
 */
export const llmCreditHolds = pgTable(
  "llm_credit_holds",
  {
    /** The credential owner (FR-011). Today the single constant "install"; entry 2 adds per-project owners. */
    owner: text("owner").primaryKey(),
    /** When this hold began. Not moved by a later refusal: the screens say "paused since" (FR-022). */
    heldSince: timestamp("held_since", { withTimezone: true }).notNull(),
    /** The most recent billing refusal seen for this owner. */
    lastRefusalAt: timestamp("last_refusal_at", { withTimezone: true }).notNull(),
    /** When one item may go through as a probe. Always now + CREDIT_PROBE_INTERVAL_MS when written (H6). */
    nextProbeAt: timestamp("next_probe_at", { withTimezone: true }).notNull(),
  },
  (t) => [check("llm_credit_holds_owner_nonempty", sql`length(${t.owner}) > 0`)],
);

/**
 * Project-owned, at most one row per project: an optional per-project LLM credential plus the check's
 * lease and cooldown bookkeeping. A row may exist with all three credential columns null (FR-021).
 * The only module that selects api_key_encrypted is src/server/dal/project-llm.ts (FR-009, FR-010).
 */
export const projectLlmSettings = pgTable(
  "project_llm_settings",
  {
    projectId: uuid("project_id")
      .primaryKey()
      .references(() => projects.id, { onDelete: "cascade" }),
    provider: text("provider"),
    model: text("model"),
    apiKeyEncrypted: text("api_key_encrypted"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    updatedByUserId: uuid("updated_by_user_id").references(() => user.id, { onDelete: "set null" }),
    lastCheckAt: timestamp("last_check_at", { withTimezone: true }),
    checkLeaseUntil: timestamp("check_lease_until", { withTimezone: true }),
  },
  (t) => [
    check("project_llm_settings_provider", sql`${t.provider} IS NULL OR ${t.provider} IN ('openai','anthropic')`),
    check(
      "project_llm_settings_credential",
      sql`(${t.provider} IS NULL AND ${t.model} IS NULL AND ${t.apiKeyEncrypted} IS NULL)
        OR (${t.provider} IS NOT NULL AND ${t.model} IS NOT NULL AND ${t.apiKeyEncrypted} IS NOT NULL)`,
    ),
    check(
      "project_llm_settings_model_shape",
      sql`${t.model} IS NULL OR (length(${t.model}) BETWEEN 1 AND 200 AND ${t.model} !~ '\\s')`,
    ),
    check("project_llm_settings_key_nonempty", sql`${t.apiKeyEncrypted} IS NULL OR length(${t.apiKeyEncrypted}) > 0`),
  ],
);

export const llmUsagePurpose = pgEnum("llm_usage_purpose", [
  "generate.single",
  "generate.series_plan",
  "generate.series_post",
  "generate.regenerate",
  "generate.job_item",
  "generate.standing_series_plan",
  "generate.standing_series_post",
  "voice.try",
  "llm.check",
  "image.generate",
  "engagement.reply",
]);

export const voiceProfiles = pgTable(
  "voice_profiles",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references((): AnyPgColumn => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    currentVersion: integer("current_version").default(1).notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdByUserId: uuid("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [
    unique("voice_profiles_project_id_uq").on(t.projectId, t.id),
    uniqueIndex("voice_profiles_project_name_uq")
      .on(t.projectId, sql`lower(${t.name})`)
      .where(sql`${t.archivedAt} IS NULL`),
    check("voice_profiles_current_version_pos", sql`${t.currentVersion} >= 1`),
  ],
);

/** Immutable: the repository has no update or delete. */
export const voiceProfileVersions = pgTable(
  "voice_profile_versions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    profileId: uuid("profile_id").notNull(),
    version: integer("version").notNull(),
    content: jsonb("content").notNull(),
    authorUserId: uuid("author_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    foreignKey({
      name: "voice_profile_versions_profile_fk",
      columns: [t.projectId, t.profileId],
      foreignColumns: [voiceProfiles.projectId, voiceProfiles.id],
    }).onDelete("cascade"),
    unique("voice_profile_versions_profile_version_uq").on(t.profileId, t.version),
    unique("voice_profile_versions_project_id_uq").on(t.projectId, t.id),
    check("voice_profile_versions_version_pos", sql`${t.version} >= 1`),
  ],
);

export const generationSeries = pgTable(
  "generation_series",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    brief: text("brief").notNull(),
    plan: jsonb("plan").notNull(),
    request: jsonb("request").notNull(),
    plannedCount: smallint("planned_count").notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique("generation_series_project_id_uq").on(t.projectId, t.id),
    check("generation_series_planned_count_range", sql`${t.plannedCount} BETWEEN 2 AND 10`),
  ],
);

export const generationFailures = pgTable(
  "generation_failures",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    mode: generationMode("mode").notNull(),
    seriesId: uuid("series_id"),
    seriesPosition: smallint("series_position"),
    standingSeriesRunId: uuid("standing_series_run_id"),
    standingSeriesPosition: smallint("standing_series_position"),
    postId: uuid("post_id").references(() => posts.id, { onDelete: "cascade" }),
    inputs: jsonb("inputs").notNull(),
    kind: llmFailureKind("kind").notNull(),
    message: text("message").notNull(),
    attempts: jsonb("attempts").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    requestedByUserId: uuid("requested_by_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    foreignKey({
      name: "generation_failures_series_fk",
      columns: [t.projectId, t.seriesId],
      foreignColumns: [generationSeries.projectId, generationSeries.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "generation_failures_standing_series_run_fk",
      columns: [t.projectId, t.standingSeriesRunId],
      foreignColumns: [standingSeriesRuns.projectId, standingSeriesRuns.id],
    }).onDelete("cascade"),
    index("generation_failures_project_created_idx").on(t.projectId, t.createdAt.desc()),
    index("generation_failures_project_run_idx")
      .on(t.projectId, t.standingSeriesRunId)
      .where(sql`${t.standingSeriesRunId} IS NOT NULL`),
    check("generation_failures_series_pair", sql`(${t.seriesId} IS NULL) = (${t.seriesPosition} IS NULL)`),
    // Phrased as the complement of the pre-standing-series modes, not as the two new values
    // themselves: a value just added by `ALTER TYPE ... ADD VALUE` cannot be used until that
    // transaction commits, and a from-scratch migration run applies this constraint in the same
    // transaction that adds the value.
    check(
      "generation_failures_standing_mode_pair",
      sql`(${t.mode} NOT IN ('single','series_plan','series_post','regenerate')) = (${t.standingSeriesRunId} IS NOT NULL)`,
    ),
    check(
      "generation_failures_standing_position_needs_run",
      sql`${t.standingSeriesPosition} IS NULL OR ${t.standingSeriesRunId} IS NOT NULL`,
    ),
  ],
);

/**
 * Project-owned, insert-only ledger: one row per model call that reached the provider and returned.
 * No prompt, output, provider error text or key fragment ever lands here (FR-004). Written only
 * through src/server/dal/llm-usage.ts, which exposes no update and no delete.
 */
export const llmCallUsage = pgTable(
  "llm_call_usage",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    purpose: llmUsagePurpose("purpose").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    credentialSource: text("credential_source").notNull(),
    ok: boolean("ok").notNull(),
    failureKind: llmFailureKind("failure_kind"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    latencyMs: integer("latency_ms").notNull(),
    calledAt: timestamp("called_at", { withTimezone: true }).notNull(),
    postId: uuid("post_id").references(() => posts.id, { onDelete: "cascade" }),
    seriesId: uuid("series_id"),
    seriesPosition: smallint("series_position"),
    generationJobId: uuid("generation_job_id"),
    generationJobItemId: uuid("generation_job_item_id"),
  },
  (t) => [
    foreignKey({
      name: "llm_call_usage_series_fk",
      columns: [t.projectId, t.seriesId],
      foreignColumns: [generationSeries.projectId, generationSeries.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "llm_call_usage_job_fk",
      columns: [t.projectId, t.generationJobId],
      foreignColumns: [generationJobs.projectId, generationJobs.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "llm_call_usage_job_item_fk",
      columns: [t.projectId, t.generationJobItemId],
      foreignColumns: [generationJobItems.projectId, generationJobItems.id],
    }).onDelete("cascade"),
    index("llm_call_usage_project_called_idx").on(t.projectId, t.calledAt.desc()),
    index("llm_call_usage_project_job_idx")
      .on(t.projectId, t.generationJobId)
      .where(sql`${t.generationJobId} IS NOT NULL`),
    check("llm_call_usage_outcome", sql`${t.ok} = (${t.failureKind} IS NULL)`),
    check("llm_call_usage_series_pair", sql`(${t.seriesId} IS NULL) = (${t.seriesPosition} IS NULL)`),
    check(
      "llm_call_usage_tokens_nonneg",
      sql`(${t.inputTokens} IS NULL OR ${t.inputTokens} >= 0) AND (${t.outputTokens} IS NULL OR ${t.outputTokens} >= 0)`,
    ),
    check("llm_call_usage_latency_nonneg", sql`${t.latencyMs} >= 0`),
    check("llm_call_usage_provider", sql`${t.provider} IN ('openai','anthropic')`),
    check("llm_call_usage_source", sql`${t.credentialSource} IN ('project','install')`),
    check("llm_call_usage_model_shape", sql`length(${t.model}) BETWEEN 1 AND 200 AND ${t.model} !~ '\\s'`),
    check(
      "llm_call_usage_job_pair",
      sql`${t.generationJobItemId} IS NULL OR ${t.generationJobId} IS NOT NULL`,
    ),
  ],
);

export type VoiceProfileRow = typeof voiceProfiles.$inferSelect;
export type VoiceProfileVersionRow = typeof voiceProfileVersions.$inferSelect;
export type GenerationSeriesRow = typeof generationSeries.$inferSelect;
export type GenerationFailureRow = typeof generationFailures.$inferSelect;
export type ProjectLlmSettingsRow = typeof projectLlmSettings.$inferSelect;
export type LlmCallUsageRow = typeof llmCallUsage.$inferSelect;
