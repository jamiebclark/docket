import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { voiceProfiles, voiceProfileVersions } from "./generation";
import { mediaAssets } from "./media";
import { approvalPolicy, schedulingPolicy } from "./policy-enums";
import { projects } from "./projects";

export const generationJobStatus = pgEnum("generation_job_status", [
  "queued",
  "running",
  "completed",
  "completed_with_failures",
  "cancelled",
]);
export const generationJobItemStatus = pgEnum("generation_job_item_status", [
  "queued",
  "running",
  "done",
  "failed",
  "cancelled",
]);
export const generationJobItemError = pgEnum("generation_job_item_error", [
  "timeout",
  "rate_limited",
  "unavailable",
  "internal",
  "interrupted",
  "invalid_output",
  "refused",
  "incomplete",
  "auth",
  "bad_request",
  "image_deleted",
  "image_unavailable",
  "no_targets",
]);

/** `status` is derived: only `refreshJobStatus` writes it (research D10). */
export const generationJobs = pgTable(
  "generation_jobs",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sourceKind: text("source_kind").notNull(),
    sourceSummary: text("source_summary").notNull(),
    sourceMeta: jsonb("source_meta").default({}).notNull(),
    voiceProfileId: uuid("voice_profile_id").notNull(),
    voiceProfileVersionId: uuid("voice_profile_version_id").notNull(),
    template: text("template").notNull(),
    templateFields: text("template_fields").array().notNull(),
    targetAccountIds: uuid("target_account_ids").array().notNull(),
    requestedApproval: approvalPolicy("requested_approval"),
    requestedScheduling: schedulingPolicy("requested_scheduling"),
    approvalPolicy: approvalPolicy("approval_policy").notNull(),
    schedulingPolicy: schedulingPolicy("scheduling_policy").notNull(),
    status: generationJobStatus("status").default("queued").notNull(),
    itemCount: integer("item_count").notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    cancelledByUserId: uuid("cancelled_by_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    lastClaimedAt: timestamp("last_claimed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [
    unique("generation_jobs_project_id_uq").on(t.projectId, t.id),
    foreignKey({
      name: "generation_jobs_voice_profile_fk",
      columns: [t.projectId, t.voiceProfileId],
      foreignColumns: [voiceProfiles.projectId, voiceProfiles.id],
    }),
    foreignKey({
      name: "generation_jobs_voice_version_fk",
      columns: [t.projectId, t.voiceProfileVersionId],
      foreignColumns: [voiceProfileVersions.projectId, voiceProfileVersions.id],
    }),
    check("generation_jobs_source_kind_len", sql`char_length(${t.sourceKind}) BETWEEN 1 AND 32`),
    check("generation_jobs_source_summary_len", sql`char_length(${t.sourceSummary}) BETWEEN 1 AND 200`),
    check("generation_jobs_template_len", sql`char_length(${t.template}) BETWEEN 1 AND 2000`),
    check("generation_jobs_targets_card", sql`cardinality(${t.targetAccountIds}) BETWEEN 1 AND 50`),
    check("generation_jobs_item_count_range", sql`${t.itemCount} BETWEEN 1 AND 500`),
    check("generation_jobs_cancelled_pair", sql`(${t.status} = 'cancelled') = (${t.cancelledAt} IS NOT NULL)`),
    check(
      "generation_jobs_finished_set",
      sql`${t.status} NOT IN ('completed','completed_with_failures') OR ${t.finishedAt} IS NOT NULL`,
    ),
    index("generation_jobs_project_created_idx").on(t.projectId, t.createdAt.desc(), t.id.desc()),
    index("generation_jobs_claim_idx")
      .on(sql`${t.lastClaimedAt} NULLS FIRST`, t.createdAt)
      .where(sql`${t.status} IN ('queued','running')`),
  ],
);

export const generationJobItems = pgTable(
  "generation_job_items",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    jobId: uuid("job_id").notNull(),
    position: integer("position").notNull(),
    label: text("label").notNull(),
    payload: jsonb("payload").notNull(),
    mediaAssetId: uuid("media_asset_id").references(() => mediaAssets.id, { onDelete: "restrict" }),
    status: generationJobItemStatus("status").default("queued").notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow().notNull(),
    leaseOwner: uuid("lease_owner"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    pendingRetry: jsonb("pending_retry"),
    lastErrorKind: generationJobItemError("last_error_kind"),
    lastError: text("last_error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [
    unique("generation_job_items_project_id_uq").on(t.projectId, t.id),
    unique("generation_job_items_job_position_uq").on(t.jobId, t.position),
    foreignKey({
      name: "generation_job_items_job_fk",
      columns: [t.projectId, t.jobId],
      foreignColumns: [generationJobs.projectId, generationJobs.id],
    }).onDelete("cascade"),
    uniqueIndex("generation_job_items_active_media_uq")
      .on(t.projectId, t.mediaAssetId)
      .where(sql`${t.mediaAssetId} IS NOT NULL AND ${t.status} IN ('queued','running','failed')`),
    check("generation_job_items_position_nonneg", sql`${t.position} >= 0`),
    check("generation_job_items_label_len", sql`char_length(${t.label}) <= 200`),
    check("generation_job_items_last_error_len", sql`${t.lastError} IS NULL OR char_length(${t.lastError}) <= 500`),
    check("generation_job_items_lease_pair", sql`(${t.leaseUntil} IS NULL) = (${t.leaseOwner} IS NULL)`),
    check("generation_job_items_running_leased", sql`(${t.status} = 'running') = (${t.leaseOwner} IS NOT NULL)`),
    check("generation_job_items_pending_retry_state", sql`${t.pendingRetry} IS NULL OR ${t.status} IN ('queued','running')`),
    index("generation_job_items_due_idx")
      .on(t.jobId, t.position)
      .where(sql`${t.status} = 'queued'`),
    index("generation_job_items_recovery_idx")
      .on(t.leaseUntil)
      .where(sql`${t.status} = 'running'`),
    index("generation_job_items_counts_idx").on(t.projectId, t.jobId, t.status),
  ],
);

export type GenerationJobRow = typeof generationJobs.$inferSelect;
export type GenerationJobItemRow = typeof generationJobItems.$inferSelect;
