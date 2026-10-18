import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgEnum, pgTable, primaryKey, smallint, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { voiceProfiles } from "./generation";
import { posts, postTargets } from "./posts";
import { projects } from "./projects";
import { socialAccounts } from "./accounts";

export const engagementItemKind = pgEnum("engagement_item_kind", ["reply", "comment", "mention", "direct_message"]);
export const engagementItemState = pgEnum("engagement_item_state", ["waiting", "answered", "dismissed"]);
export const engagementDraftState = pgEnum("engagement_draft_state", ["needs_review", "approved", "rejected", "discarded"]);
export const engagementDraftOrigin = pgEnum("engagement_draft_origin", ["model", "person"]);
export const engagementSendState = pgEnum("engagement_send_state", ["none", "waiting", "sending", "sent", "failed", "ambiguous"]);

/**
 * One thing somebody said (data-model.md §2). Immutable by the repo's shape, not a trigger:
 * `EngagementItemsRepo` exposes no way to write `text`, `external_id`, `said_at` or any author column
 * outside `insertIfAbsent` (FR-010). There is deliberately no author table (FR-018): identity is
 * unmergeable by construction.
 */
export const engagementItems = pgTable(
  "engagement_items",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    socialAccountId: uuid("social_account_id")
      .notNull()
      .references(() => socialAccounts.id, { onDelete: "cascade" }),
    providerKey: text("provider_key").notNull(),
    kind: engagementItemKind("kind").notNull(),
    externalId: text("external_id").notNull(),
    text: text("text").notNull(),
    textTruncated: boolean("text_truncated").default(false).notNull(),
    authorDisplayName: text("author_display_name"),
    authorHandle: text("author_handle"),
    authorExternalId: text("author_external_id"),
    authorUrl: text("author_url"),
    authorIdentityStable: boolean("author_identity_stable").notNull(),
    authorReachable: boolean("author_reachable").default(true).notNull(),
    saidAt: timestamp("said_at", { withTimezone: true }).notNull(),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull(),
    parentExternalId: text("parent_external_id"),
    parentPostId: uuid("parent_post_id").references(() => posts.id, { onDelete: "set null" }),
    parentPostTargetId: uuid("parent_post_target_id").references(() => postTargets.id, { onDelete: "set null" }),
    providerData: jsonb("provider_data").default({}).notNull(),
    state: engagementItemState("state").default("waiting").notNull(),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    editedUpstreamAt: timestamp("edited_upstream_at", { withTimezone: true }),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    dismissedByUserId: uuid("dismissed_by_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique("engagement_items_identity_uq").on(t.projectId, t.socialAccountId, t.externalId),
    check("engagement_items_answered_pair", sql`(${t.state} = 'answered') = (${t.answeredAt} IS NOT NULL)`),
    check("engagement_items_dismissed_pair", sql`(${t.state} = 'dismissed') = (${t.dismissedAt} IS NOT NULL)`),
    check("engagement_items_identity_stable", sql`${t.authorIdentityStable} IS FALSE OR ${t.authorExternalId} IS NOT NULL`),
    check("engagement_items_external_id_len", sql`char_length(${t.externalId}) BETWEEN 1 AND 200`),
    check("engagement_items_external_id_trimmed", sql`btrim(${t.externalId}) = ${t.externalId}`),
    check("engagement_items_text_len", sql`char_length(${t.text}) <= 10000`),
    check("engagement_items_author_display_name_len", sql`${t.authorDisplayName} IS NULL OR char_length(${t.authorDisplayName}) <= 200`),
    check("engagement_items_author_handle_len", sql`${t.authorHandle} IS NULL OR char_length(${t.authorHandle}) <= 200`),
    check("engagement_items_author_external_id_len", sql`${t.authorExternalId} IS NULL OR char_length(${t.authorExternalId}) <= 200`),
    check("engagement_items_author_url_len", sql`${t.authorUrl} IS NULL OR char_length(${t.authorUrl}) <= 2000`),
    check("engagement_items_provider_data_size", sql`octet_length(${t.providerData}::text) <= 2000`),
    check("engagement_items_said_at_ms", sql`${t.saidAt} = date_trunc('milliseconds', ${t.saidAt})`),
    index("engagement_items_project_state_said_idx").on(t.projectId, t.state, t.saidAt.desc()),
    index("engagement_items_project_account_said_idx").on(t.projectId, t.socialAccountId, t.saidAt.desc()),
    index("engagement_items_project_parent_idx").on(t.projectId, t.parentExternalId).where(sql`${t.parentExternalId} IS NOT NULL`),
    index("engagement_items_said_idx").on(t.saidAt),
  ],
);

export type EngagementItemRow = typeof engagementItems.$inferSelect;

/**
 * A proposed answer (data-model.md §3). `send_state = 'none' OR review_state = 'approved'` is the
 * database-level backstop for FR-028: no configuration, policy value, permission or job can get
 * round it.
 */
export const engagementDrafts = pgTable(
  "engagement_drafts",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    engagementItemId: uuid("engagement_item_id")
      .notNull()
      .references(() => engagementItems.id, { onDelete: "cascade" }),
    socialAccountId: uuid("social_account_id")
      .notNull()
      .references(() => socialAccounts.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    origin: engagementDraftOrigin("origin").notNull(),
    voiceProfileId: uuid("voice_profile_id").references(() => voiceProfiles.id, { onDelete: "set null" }),
    voiceProfileVersion: integer("voice_profile_version"),
    requestedByUserId: uuid("requested_by_user_id").references(() => user.id, { onDelete: "set null" }),
    reviewState: engagementDraftState("review_state").default("needs_review").notNull(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedByUserId: uuid("reviewed_by_user_id").references(() => user.id, { onDelete: "set null" }),
    rejectionReason: text("rejection_reason"),
    acknowledgedEditAt: timestamp("acknowledged_edit_at", { withTimezone: true }),
    sendState: engagementSendState("send_state").default("none").notNull(),
    sendLeaseUntil: timestamp("send_lease_until", { withTimezone: true }),
    sendLeaseOwner: uuid("send_lease_owner"),
    sendAttempts: smallint("send_attempts").default(0).notNull(),
    sendNotBefore: timestamp("send_not_before", { withTimezone: true }),
    sendWaitReason: text("send_wait_reason"),
    externalReplyId: text("external_reply_id"),
    externalReplyUrl: text("external_reply_url"),
    sentText: text("sent_text"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("engagement_drafts_one_live_answer_uq").on(t.engagementItemId).where(sql`${t.reviewState} = 'approved'`),
    index("engagement_drafts_project_review_idx").on(t.projectId, t.reviewState, t.createdAt.desc()),
    index("engagement_drafts_send_claim_idx")
      .on(t.sendNotBefore, t.id)
      .where(sql`${t.reviewState} = 'approved' AND ${t.sendState} IN ('waiting', 'sending')`),
    index("engagement_drafts_item_thread_idx").on(t.projectId, t.engagementItemId, t.createdAt.desc()),
    check("engagement_drafts_send_requires_approved", sql`${t.sendState} = 'none' OR ${t.reviewState} = 'approved'`),
    // `reviewed_at` is required, the reviewer is not. `reviewed_by_user_id` is ON DELETE SET NULL,
    // like all 38 other actor columns in this schema, so requiring it NOT NULL here made the two rules
    // contradict each other: deleting a user whose draft had been decided set the column null and the
    // check then rejected the delete with 23514, so that user could never be removed at all.
    // Found via flake-hunt run 39096335776 — `delete from "user"` in security/secret-scan.test.ts,
    // which had failed 8 to 11 of 20 repetitions across four hunts with the cause swallowed twice over.
    // The audit intent is kept: a decided draft still records WHEN it was decided, and by whom for as
    // long as that person exists.
    check(
      "engagement_drafts_decision_names_person",
      sql`${t.reviewState} IN ('needs_review', 'discarded') OR ${t.reviewedAt} IS NOT NULL`,
    ),
    check(
      "engagement_drafts_model_origin_voice",
      sql`${t.origin} <> 'model' OR (${t.voiceProfileId} IS NOT NULL AND ${t.voiceProfileVersion} IS NOT NULL)`,
    ),
    check("engagement_drafts_sent_pair", sql`(${t.sendState} = 'sent') = (${t.sentAt} IS NOT NULL)`),
    check(
      "engagement_drafts_sent_fields",
      sql`${t.sendState} <> 'sent' OR (${t.externalReplyId} IS NOT NULL AND ${t.sentText} IS NOT NULL)`,
    ),
    check("engagement_drafts_lease_pair", sql`(${t.sendLeaseUntil} IS NULL) = (${t.sendLeaseOwner} IS NULL)`),
    check("engagement_drafts_text_len", sql`char_length(${t.text}) BETWEEN 1 AND 10000`),
    check("engagement_drafts_rejection_reason_len", sql`${t.rejectionReason} IS NULL OR char_length(${t.rejectionReason}) <= 500`),
  ],
);

export type EngagementDraftRow = typeof engagementDrafts.$inferSelect;

/**
 * The send ledger (data-model.md §4), in the shape of `external_item_claims`. A row is inserted
 * live (`released_at`/`release_reason` both null) and later released in place — this is the one
 * permitted post-insert write, since a live claim must stay distinguishable from a released one at
 * every generation, not just generation 1. Keyed on the platform's own identifier so it survives
 * retention deleting the item (research.md §3). `draft_id`/`engagement_item_id` are deliberately not
 * foreign keys, so the ledger outlives both.
 */
export const engagementReplyClaims = pgTable(
  "engagement_reply_claims",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    socialAccountId: uuid("social_account_id")
      .notNull()
      .references(() => socialAccounts.id, { onDelete: "cascade" }),
    itemExternalId: text("item_external_id").notNull(),
    generation: smallint("generation").default(1).notNull(),
    draftId: uuid("draft_id").notNull(),
    engagementItemId: uuid("engagement_item_id"),
    approvedByUserId: uuid("approved_by_user_id").references(() => user.id, { onDelete: "set null" }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).defaultNow().notNull(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    releaseReason: text("release_reason"),
    releasedByUserId: uuid("released_by_user_id").references(() => user.id, { onDelete: "set null" }),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.socialAccountId, t.itemExternalId, t.generation] }),
    index("engagement_reply_claims_window_idx").on(t.projectId, t.socialAccountId, t.claimedAt),
    check("engagement_reply_claims_generation_min", sql`${t.generation} >= 1`),
    check("engagement_reply_claims_release_pair", sql`(${t.releasedAt} IS NULL) = (${t.releaseReason} IS NULL)`),
    check(
      "engagement_reply_claims_release_reason_enum",
      sql`${t.releaseReason} IS NULL OR ${t.releaseReason} IN ('definite_failure', 'member_decision')`,
    ),
    check(
      "engagement_reply_claims_member_decision_named",
      sql`${t.releaseReason} <> 'member_decision' OR ${t.releasedByUserId} IS NOT NULL`,
    ),
    check("engagement_reply_claims_item_external_id_len", sql`char_length(${t.itemExternalId}) BETWEEN 1 AND 200`),
    check("engagement_reply_claims_item_external_id_trimmed", sql`btrim(${t.itemExternalId}) = ${t.itemExternalId}`),
  ],
);

export type EngagementReplyClaimRow = typeof engagementReplyClaims.$inferSelect;

/**
 * Per connected account (data-model.md §5). Created lazily the first time an account with a declared
 * engagement capability is claimed; an account whose provider declares nothing never gets a row.
 */
export const engagementAccountStates = pgTable(
  "engagement_account_states",
  {
    socialAccountId: uuid("social_account_id")
      .primaryKey()
      .references(() => socialAccounts.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    cursor: text("cursor"),
    providerState: jsonb("provider_state").default({}).notNull(),
    backfilling: boolean("backfilling").default(false).notNull(),
    readLeaseUntil: timestamp("read_lease_until", { withTimezone: true }),
    readLeaseOwner: uuid("read_lease_owner"),
    readNotBefore: timestamp("read_not_before", { withTimezone: true }),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }),
    lastItemAt: timestamp("last_item_at", { withTimezone: true }),
    consecutiveFailures: smallint("consecutive_failures").default(0).notNull(),
    lastError: text("last_error"),
    gapAt: timestamp("gap_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("engagement_account_states_read_claim_idx").on(t.readNotBefore).where(sql`${t.readLeaseUntil} IS NULL`),
    check("engagement_account_states_lease_pair", sql`(${t.readLeaseUntil} IS NULL) = (${t.readLeaseOwner} IS NULL)`),
    check("engagement_account_states_failures_nonneg", sql`${t.consecutiveFailures} >= 0`),
    check("engagement_account_states_cursor_len", sql`${t.cursor} IS NULL OR char_length(${t.cursor}) <= 500`),
    check("engagement_account_states_provider_state_size", sql`octet_length(${t.providerState}::text) <= 2000`),
  ],
);

export type EngagementAccountStateRow = typeof engagementAccountStates.$inferSelect;
