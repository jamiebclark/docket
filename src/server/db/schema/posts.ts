import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
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
import { postingSlots, socialAccounts } from "./accounts";
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
    stepState: jsonb("step_state"),
    inFlightStep: text("in_flight_step"),
    inFlightMayPublish: boolean("in_flight_may_publish"),
    firstStepAt: timestamp("first_step_at", { withTimezone: true }),
    publishStartedAt: timestamp("publish_started_at", { withTimezone: true }),
    attemptCount: integer("attempt_count").default(0).notNull(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    leaseOwner: uuid("lease_owner"),
    lastError: text("last_error"),
    externalId: text("external_id"),
    externalUrl: text("external_url"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    resolvedByUserId: uuid("resolved_by_user_id").references(() => user.id, { onDelete: "set null" }),
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
    check("post_targets_lease_pair", sql`(${t.leaseUntil} IS NULL) = (${t.leaseOwner} IS NULL)`),
    check(
      "post_targets_live_has_schedule",
      sql`${t.status} NOT IN ('scheduled','publishing') OR (${t.nextAttemptAt} IS NOT NULL AND ${t.scheduledAt} IS NOT NULL AND ${t.scheduleKind} IS NOT NULL)`,
    ),
    check(
      "post_targets_published_has_id",
      sql`${t.status} <> 'published' OR ${t.externalId} IS NOT NULL OR ${t.resolvedAt} IS NOT NULL`,
    ),
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
  ],
);

export type PostRow = typeof posts.$inferSelect;
export type PostTargetRow = typeof postTargets.$inferSelect;
export type PostStatus = PostRow["status"];
export type PostTargetStatus = PostTargetRow["status"];
