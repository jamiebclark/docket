import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  doublePrecision,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { PostType } from "../../../providers/types";
import { postingSlots, socialAccounts } from "./accounts";
import { apiKeys } from "./api";
import { user } from "./auth";
import { mediaAssets } from "./media";
import { generationSeries } from "./generation";
import { generationJobItems } from "./jobs";
import { schedulingPolicy } from "./policy-enums";
import { projects } from "./projects";

export const postStatus = pgEnum("post_status", [
  "draft",
  "needs_review",
  "approved",
  "scheduled",
  "publishing",
  "published",
  "partially_failed",
  "failed",
  "rejected",
]);
export const postReviewState = pgEnum("post_review_state", ["draft", "needs_review", "approved", "rejected"]);
export const postOrigin = pgEnum("post_origin", ["manual", "generated", "api"]);
export const postTargetStatus = pgEnum("post_target_status", [
  "draft",
  "scheduled",
  "publishing",
  "published",
  "failed",
  "ambiguous",
  "cancelled",
]);
export const scheduleKind = pgEnum("schedule_kind", ["slot", "explicit", "now"]);

/** `status` is derived (research D11): only `applyDerivedStatus` writes it. */
export const posts = pgTable(
  "posts",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    status: postStatus("status").default("draft").notNull(),
    reviewState: postReviewState("review_state").default("draft").notNull(),
    baseText: text("base_text").default("").notNull(),
    origin: postOrigin("origin").default("manual").notNull(),
    generationMetadata: jsonb("generation_metadata"),
    generationRequestId: uuid("generation_request_id"),
    schedulingPolicy: schedulingPolicy("scheduling_policy"),
    seriesId: uuid("series_id"),
    seriesPosition: smallint("series_position"),
    generationJobItemId: uuid("generation_job_item_id"),
    reviewedByUserId: uuid("reviewed_by_user_id").references(() => user.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    rejectionReason: text("rejection_reason"),
    createdByUserId: uuid("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    createdByApiKeyId: uuid("created_by_api_key_id"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [
    index("posts_project_status_idx")
      .on(t.projectId, t.status)
      .where(sql`${t.deletedAt} IS NULL`),
    uniqueIndex("posts_generation_request_uq")
      .on(t.projectId, t.generationRequestId)
      .where(sql`${t.generationRequestId} IS NOT NULL AND ${t.deletedAt} IS NULL`),
    uniqueIndex("posts_series_position_uq")
      .on(t.seriesId, t.seriesPosition)
      .where(sql`${t.seriesId} IS NOT NULL AND ${t.deletedAt} IS NULL`),
    check("posts_series_pair", sql`(${t.seriesId} IS NULL) = (${t.seriesPosition} IS NULL)`),
    foreignKey({
      name: "posts_api_key_fk",
      columns: [t.projectId, t.createdByApiKeyId],
      foreignColumns: [apiKeys.projectId, apiKeys.id],
    }),
    foreignKey({
      name: "posts_series_fk",
      columns: [t.projectId, t.seriesId],
      foreignColumns: [generationSeries.projectId, generationSeries.id],
    }),
    foreignKey({
      name: "posts_generation_job_item_fk",
      columns: [t.projectId, t.generationJobItemId],
      foreignColumns: [generationJobItems.projectId, generationJobItems.id],
    }),
    uniqueIndex("posts_generation_job_item_uq")
      .on(t.generationJobItemId)
      .where(sql`${t.generationJobItemId} IS NOT NULL AND ${t.deletedAt} IS NULL`),
    index("posts_review_queue_idx")
      .on(t.projectId, t.reviewState, t.createdAt.desc())
      .where(sql`${t.deletedAt} IS NULL`),
  ],
);

/** The ordered media of a post. */
export const postMedia = pgTable(
  "post_media",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    mediaAssetId: uuid("media_asset_id")
      .notNull()
      .references(() => mediaAssets.id, { onDelete: "restrict" }),
    position: smallint("position").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.postId, t.position] }),
    unique("post_media_post_asset_uq").on(t.postId, t.mediaAssetId),
    check("post_media_position_nonneg", sql`${t.position} >= 0`),
  ],
);

/** One trim-and-fit edit of one video in one post. No row means the default edit. */
export const postVideoEdits = pgTable(
  "post_video_edits",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    mediaAssetId: uuid("media_asset_id")
      .notNull()
      .references(() => mediaAssets.id, { onDelete: "cascade" }),
    trimStartMs: integer("trim_start_ms").notNull().default(0),
    trimEndMs: integer("trim_end_ms"),
    fit: text("fit").notNull().default("pad_blur"),
    padColor: text("pad_color").notNull().default("#000000"),
    focalX: doublePrecision("focal_x").notNull().default(0.5),
    focalY: doublePrecision("focal_y").notNull().default(0.5),
    recommendedShape: boolean("recommended_shape").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.postId, t.mediaAssetId] }),
    index("post_video_edits_project_post_idx").on(t.projectId, t.postId),
    check("post_video_edits_trim_start_valid", sql`${t.trimStartMs} >= 0 AND ${t.trimStartMs} % 100 = 0`),
    check(
      "post_video_edits_trim_end_valid",
      sql`${t.trimEndMs} IS NULL OR (${t.trimEndMs} > ${t.trimStartMs} + 999 AND ${t.trimEndMs} % 100 = 0)`,
    ),
    check("post_video_edits_fit_valid", sql`${t.fit} IN ('pad_blur','pad_color','crop')`),
    check("post_video_edits_pad_color_valid", sql`${t.padColor} ~ '^#[0-9a-f]{6}$'`),
    check("post_video_edits_focal_x_valid", sql`${t.focalX} BETWEEN 0 AND 1`),
    check("post_video_edits_focal_y_valid", sql`${t.focalY} BETWEEN 0 AND 1`),
  ],
);

/** One post going to one account: the unit the scheduler works on. */
export const postTargets = pgTable(
  "post_targets",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    socialAccountId: uuid("social_account_id")
      .notNull()
      .references(() => socialAccounts.id, { onDelete: "restrict" }),
    status: postTargetStatus("status").default("draft").notNull(),
    scheduleKind: scheduleKind("schedule_kind"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    slotId: uuid("slot_id").references(() => postingSlots.id, { onDelete: "set null" }),
    slotOccurrenceAt: timestamp("slot_occurrence_at", { withTimezone: true }),
    overrideText: text("override_text"),
    /** The post type a person or API caller chose; null = the provider's default. */
    chosenPostType: text("chosen_post_type").$type<PostType>(),
    /** The target's posting values (G25), parsed by the provider's `posting.valuesSchema`; null = never set. */
    postingFields: jsonb("posting_fields"),
    /** Who agreed to the provider's consent declaration (G27), when, and the fingerprint and details shown. */
    consentByUserId: uuid("consent_by_user_id").references(() => user.id, { onDelete: "set null" }),
    consentAt: timestamp("consent_at", { withTimezone: true }),
    consentFingerprint: text("consent_fingerprint"),
    consentDetails: jsonb("consent_details"),
    stepState: jsonb("step_state"),
    inFlightStep: text("in_flight_step"),
    inFlightMayPublish: boolean("in_flight_may_publish"),
    firstStepAt: timestamp("first_step_at", { withTimezone: true }),
    publishStartedAt: timestamp("publish_started_at", { withTimezone: true }),
    videoWaitSince: timestamp("video_wait_since", { withTimezone: true }),
    attemptCount: integer("attempt_count").default(0).notNull(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    leaseOwner: uuid("lease_owner"),
    lastError: text("last_error"),
    externalId: text("external_id"),
    externalUrl: text("external_url"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    resolvedByUserId: uuid("resolved_by_user_id").references(() => user.id, { onDelete: "set null" }),
    resolvedByApiKeyId: uuid("resolved_by_api_key_id"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [
    unique("post_targets_post_account_uq").on(t.postId, t.socialAccountId),
    uniqueIndex("post_targets_occurrence_uq")
      .on(t.socialAccountId, t.slotOccurrenceAt)
      .where(sql`${t.slotOccurrenceAt} IS NOT NULL`),
    check(
      "post_targets_occurrence_is_slot",
      sql`${t.slotOccurrenceAt} IS NULL OR ${t.scheduleKind} = 'slot'`,
    ),
    check(
      "post_targets_chosen_post_type_known",
      sql`${t.chosenPostType} IS NULL OR ${t.chosenPostType} IN ('text','image','carousel','video','story','reel')`,
    ),
    check(
      "post_targets_consent_pair",
      sql`(${t.consentAt} IS NULL) = (${t.consentFingerprint} IS NULL) AND (${t.consentDetails} IS NULL OR ${t.consentFingerprint} IS NOT NULL)`,
    ),
    check("post_targets_lease_pair", sql`(${t.leaseUntil} IS NULL) = (${t.leaseOwner} IS NULL)`),
    check(
      "post_targets_live_has_schedule",
      sql`${t.status} NOT IN ('scheduled','publishing') OR (${t.nextAttemptAt} IS NOT NULL AND ${t.scheduledAt} IS NOT NULL AND ${t.scheduleKind} IS NOT NULL)`,
    ),
    check(
      "post_targets_published_has_id",
      sql`${t.status} <> 'published' OR ${t.externalId} IS NOT NULL OR ${t.resolvedAt} IS NOT NULL`,
    ),
    foreignKey({
      name: "post_targets_resolver_api_key_fk",
      columns: [t.projectId, t.resolvedByApiKeyId],
      foreignColumns: [apiKeys.projectId, apiKeys.id],
    }),
    index("post_targets_due_idx")
      .on(t.nextAttemptAt)
      .where(sql`${t.status} IN ('scheduled','publishing')`),
    index("post_targets_started_idx")
      .on(t.socialAccountId, t.publishStartedAt)
      .where(sql`${t.publishStartedAt} IS NOT NULL`),
    index("post_targets_account_sched_idx")
      .on(t.socialAccountId, t.scheduledAt)
      .where(sql`${t.status} = 'scheduled'`),
    index("post_targets_project_post_idx").on(t.projectId, t.postId),
    index("post_targets_attention_idx")
      .on(t.projectId, t.updatedAt.desc(), t.id)
      .where(sql`${t.status} IN ('ambiguous','failed')`),
  ],
);

export type PostVideoEditRow = typeof postVideoEdits.$inferSelect;
export type PostRow = typeof posts.$inferSelect;
export type PostTargetRow = typeof postTargets.$inferSelect;
export type PostStatus = PostRow["status"];
export type PostTargetStatus = PostTargetRow["status"];
