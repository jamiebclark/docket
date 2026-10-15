import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  engagementAccountStates,
  engagementDrafts,
  engagementItems,
  engagementReplyClaims,
  type EngagementAccountStateRow,
  type EngagementDraftRow,
  type EngagementItemRow,
  type EngagementReplyClaimRow,
} from "../db/schema";

export type { EngagementAccountStateRow, EngagementDraftRow, EngagementItemRow, EngagementReplyClaimRow } from "../db/schema";

export interface NewEngagementItem {
  socialAccountId: string;
  providerKey: string;
  kind: EngagementItemRow["kind"];
  externalId: string;
  text: string;
  textTruncated?: boolean;
  authorDisplayName: string | null;
  authorHandle: string | null;
  authorExternalId: string | null;
  authorUrl: string | null;
  authorIdentityStable: boolean;
  authorReachable?: boolean;
  saidAt: Date;
  ingestedAt: Date;
  parentExternalId: string | null;
  parentPostId?: string | null;
  parentPostTargetId?: string | null;
  providerData?: unknown;
}

/**
 * Items, immutable after ingest (data-model.md §2, FR-010). No method here writes `text`,
 * `external_id`, `said_at` or any author column outside `insertIfAbsent` — that is the whole of the
 * enforcement; there is no trigger.
 */
export interface EngagementItemsRepo {
  /** `ON CONFLICT DO NOTHING` on `(project_id, social_account_id, external_id)` (FR-009). */
  insertIfAbsent(input: NewEngagementItem): Promise<{ id: string; inserted: boolean }>;
  markWithdrawn(id: string, at: Date): Promise<void>;
  markEditedUpstream(id: string, at: Date): Promise<void>;
  markAnswered(id: string, at: Date): Promise<void>;
  markDismissed(id: string, at: Date, byUserId: string | null): Promise<void>;
  get(id: string): Promise<EngagementItemRow | null>;
  getByExternalId(socialAccountId: string, externalId: string): Promise<EngagementItemRow | null>;
  list(input: {
    socialAccountId?: string;
    state?: EngagementItemRow["state"];
    kind?: EngagementItemRow["kind"];
    limit: number;
    offset?: number;
  }): Promise<EngagementItemRow[]>;
  count(input: { socialAccountId?: string; state?: EngagementItemRow["state"]; kind?: EngagementItemRow["kind"] }): Promise<number>;
  countWaiting(): Promise<number>;
  /** How many items newer than this one share the same `parent_external_id` (the "newer comments" edge case). */
  countNewerOnSameParent(parentExternalId: string, saidAt: Date): Promise<number>;
}

export function createEngagementItemsRepo(exec: Database, projectId: string): EngagementItemsRepo {
  const inProject = eq(engagementItems.projectId, projectId);
  const getByExternalId: EngagementItemsRepo["getByExternalId"] = async (socialAccountId, externalId) => {
    const [row] = await exec
      .select()
      .from(engagementItems)
      .where(and(inProject, eq(engagementItems.socialAccountId, socialAccountId), eq(engagementItems.externalId, externalId)))
      .limit(1);
    return row ?? null;
  };
  return {
    async insertIfAbsent(input) {
      const [row] = await exec
        .insert(engagementItems)
        .values({
          projectId,
          socialAccountId: input.socialAccountId,
          providerKey: input.providerKey,
          kind: input.kind,
          externalId: input.externalId,
          text: input.text,
          textTruncated: input.textTruncated ?? false,
          authorDisplayName: input.authorDisplayName,
          authorHandle: input.authorHandle,
          authorExternalId: input.authorExternalId,
          authorUrl: input.authorUrl,
          authorIdentityStable: input.authorIdentityStable,
          authorReachable: input.authorReachable ?? true,
          saidAt: input.saidAt,
          ingestedAt: input.ingestedAt,
          parentExternalId: input.parentExternalId,
          parentPostId: input.parentPostId ?? null,
          parentPostTargetId: input.parentPostTargetId ?? null,
          providerData: input.providerData ?? {},
        })
        .onConflictDoNothing({ target: [engagementItems.projectId, engagementItems.socialAccountId, engagementItems.externalId] })
        .returning({ id: engagementItems.id });
      if (row) return { id: row.id, inserted: true };
      const existing = await getByExternalId(input.socialAccountId, input.externalId);
      return { id: existing!.id, inserted: false };
    },
    async markWithdrawn(id, at) {
      await exec.update(engagementItems).set({ withdrawnAt: at }).where(and(inProject, eq(engagementItems.id, id)));
    },
    async markEditedUpstream(id, at) {
      await exec.update(engagementItems).set({ editedUpstreamAt: at }).where(and(inProject, eq(engagementItems.id, id)));
    },
    async markAnswered(id, at) {
      await exec.update(engagementItems).set({ state: "answered", answeredAt: at }).where(and(inProject, eq(engagementItems.id, id)));
    },
    async markDismissed(id, at, byUserId) {
      await exec
        .update(engagementItems)
        .set({ state: "dismissed", dismissedAt: at, dismissedByUserId: byUserId })
        .where(and(inProject, eq(engagementItems.id, id)));
    },
    async get(id) {
      const [row] = await exec.select().from(engagementItems).where(and(inProject, eq(engagementItems.id, id))).limit(1);
      return row ?? null;
    },
    getByExternalId,
    async list(input) {
      const conditions = [inProject];
      if (input.socialAccountId) conditions.push(eq(engagementItems.socialAccountId, input.socialAccountId));
      if (input.state) conditions.push(eq(engagementItems.state, input.state));
      if (input.kind) conditions.push(eq(engagementItems.kind, input.kind));
      const rows = await exec
        .select()
        .from(engagementItems)
        .where(and(...conditions))
        .orderBy(desc(engagementItems.saidAt))
        .limit(input.limit)
        .offset(input.offset ?? 0);
      return rows;
    },
    async count(input) {
      const conditions = [inProject];
      if (input.socialAccountId) conditions.push(eq(engagementItems.socialAccountId, input.socialAccountId));
      if (input.state) conditions.push(eq(engagementItems.state, input.state));
      if (input.kind) conditions.push(eq(engagementItems.kind, input.kind));
      const [row] = await exec
        .select({ n: sql<number>`count(*)::int` })
        .from(engagementItems)
        .where(and(...conditions));
      return row?.n ?? 0;
    },
    async countWaiting() {
      const [row] = await exec
        .select({ n: sql<number>`count(*)::int` })
        .from(engagementItems)
        .where(and(inProject, eq(engagementItems.state, "waiting")));
      return row?.n ?? 0;
    },
    async countNewerOnSameParent(parentExternalId, saidAt) {
      const [row] = await exec
        .select({ n: sql<number>`count(*)::int` })
        .from(engagementItems)
        .where(and(inProject, eq(engagementItems.parentExternalId, parentExternalId), sql`${engagementItems.saidAt} > ${saidAt}`));
      return row?.n ?? 0;
    },
  };
}

export interface NewEngagementDraft {
  engagementItemId: string;
  socialAccountId: string;
  text: string;
  origin: EngagementDraftRow["origin"];
  voiceProfileId?: string | null;
  voiceProfileVersion?: number | null;
  requestedByUserId?: string | null;
}

export interface EngagementDraftsRepo {
  insert(input: NewEngagementDraft): Promise<EngagementDraftRow>;
  get(id: string): Promise<EngagementDraftRow | null>;
  /** `SELECT … FOR UPDATE`, for the shared `decide()` core. */
  lockForUpdate(id: string): Promise<EngagementDraftRow | null>;
  listByItem(itemId: string): Promise<EngagementDraftRow[]>;
  listQueue(input: { limit: number; offset?: number }): Promise<EngagementDraftRow[]>;
  countQueue(): Promise<number>;
  update(id: string, patch: Partial<Omit<EngagementDraftRow, "id" | "projectId" | "createdAt">>): Promise<void>;
  /** `review_state = 'discarded'` for every other `needs_review` draft on the same item. */
  discardSiblings(itemId: string, keepId: string): Promise<void>;
}

export function createEngagementDraftsRepo(exec: Database, projectId: string): EngagementDraftsRepo {
  const inProject = eq(engagementDrafts.projectId, projectId);
  return {
    async insert(input) {
      const [row] = await exec
        .insert(engagementDrafts)
        .values({
          projectId,
          engagementItemId: input.engagementItemId,
          socialAccountId: input.socialAccountId,
          text: input.text,
          origin: input.origin,
          voiceProfileId: input.voiceProfileId ?? null,
          voiceProfileVersion: input.voiceProfileVersion ?? null,
          requestedByUserId: input.requestedByUserId ?? null,
        })
        .returning();
      return row!;
    },
    async get(id) {
      const [row] = await exec.select().from(engagementDrafts).where(and(inProject, eq(engagementDrafts.id, id))).limit(1);
      return row ?? null;
    },
    async lockForUpdate(id) {
      const [row] = await exec
        .select()
        .from(engagementDrafts)
        .where(and(inProject, eq(engagementDrafts.id, id)))
        .for("update")
        .limit(1);
      return row ?? null;
    },
    async listByItem(itemId) {
      return exec
        .select()
        .from(engagementDrafts)
        .where(and(inProject, eq(engagementDrafts.engagementItemId, itemId)))
        .orderBy(desc(engagementDrafts.createdAt));
    },
    async listQueue(input) {
      return exec
        .select()
        .from(engagementDrafts)
        .where(and(inProject, eq(engagementDrafts.reviewState, "needs_review")))
        .orderBy(desc(engagementDrafts.createdAt))
        .limit(input.limit)
        .offset(input.offset ?? 0);
    },
    async countQueue() {
      const [row] = await exec
        .select({ n: sql<number>`count(*)::int` })
        .from(engagementDrafts)
        .where(and(inProject, eq(engagementDrafts.reviewState, "needs_review")));
      return row?.n ?? 0;
    },
    async update(id, patch) {
      await exec
        .update(engagementDrafts)
        .set(patch as Record<string, unknown>)
        .where(and(inProject, eq(engagementDrafts.id, id)));
    },
    async discardSiblings(itemId, keepId) {
      await exec
        .update(engagementDrafts)
        .set({ reviewState: "discarded" })
        .where(
          and(
            inProject,
            eq(engagementDrafts.engagementItemId, itemId),
            eq(engagementDrafts.reviewState, "needs_review"),
            sql`${engagementDrafts.id} <> ${keepId}`,
          ),
        );
    },
  };
}

export interface EngagementAccountStatesRepo {
  /** Creates the row the first time this account is claimed (data-model.md §5); a no-op after. */
  ensure(socialAccountId: string): Promise<void>;
  get(socialAccountId: string): Promise<EngagementAccountStateRow | null>;
  setAutoDraft(socialAccountId: string, on: boolean): Promise<void>;
  update(socialAccountId: string, patch: Partial<Omit<EngagementAccountStateRow, "socialAccountId" | "projectId" | "createdAt">>): Promise<void>;
}

export function createEngagementAccountStatesRepo(exec: Database, projectId: string): EngagementAccountStatesRepo {
  const inProject = eq(engagementAccountStates.projectId, projectId);
  return {
    async ensure(socialAccountId) {
      await exec.insert(engagementAccountStates).values({ socialAccountId, projectId }).onConflictDoNothing({ target: engagementAccountStates.socialAccountId });
    },
    async get(socialAccountId) {
      const [row] = await exec
        .select()
        .from(engagementAccountStates)
        .where(and(inProject, eq(engagementAccountStates.socialAccountId, socialAccountId)))
        .limit(1);
      return row ?? null;
    },
    async setAutoDraft(socialAccountId, on) {
      await exec
        .update(engagementAccountStates)
        .set({ autoDraft: on })
        .where(and(inProject, eq(engagementAccountStates.socialAccountId, socialAccountId)));
    },
    async update(socialAccountId, patch) {
      await exec
        .update(engagementAccountStates)
        .set(patch as Record<string, unknown>)
        .where(and(inProject, eq(engagementAccountStates.socialAccountId, socialAccountId)));
    },
  };
}

export interface NewEngagementReplyClaim {
  socialAccountId: string;
  itemExternalId: string;
  generation: number;
  draftId: string;
  engagementItemId: string | null;
  approvedByUserId: string | null;
  claimedAt: Date;
  releaseReason?: "definite_failure" | "member_decision" | null;
  releasedByUserId?: string | null;
}

/**
 * The send ledger (data-model.md §4): insert-only, never updated, never deleted by any code path
 * (research.md §3). A unique-violation on insert means a concurrent attempt already claimed this
 * generation — the whole of FR-039.
 */
export interface EngagementReplyClaimsRepo {
  insert(input: NewEngagementReplyClaim): Promise<void>;
  /** The highest-generation row for this item, or null if never claimed. */
  latest(socialAccountId: string, itemExternalId: string): Promise<EngagementReplyClaimRow | null>;
  /** Claims in `[since, now]` for one account — what the write-budget reserve counts (research.md §8). */
  countInWindow(socialAccountId: string, since: Date): Promise<number>;
}

export function createEngagementReplyClaimsRepo(exec: Database, projectId: string): EngagementReplyClaimsRepo {
  const inProject = eq(engagementReplyClaims.projectId, projectId);
  return {
    async insert(input) {
      await exec.insert(engagementReplyClaims).values({ projectId, ...input });
    },
    async latest(socialAccountId, itemExternalId) {
      const [row] = await exec
        .select()
        .from(engagementReplyClaims)
        .where(
          and(
            inProject,
            eq(engagementReplyClaims.socialAccountId, socialAccountId),
            eq(engagementReplyClaims.itemExternalId, itemExternalId),
          ),
        )
        .orderBy(desc(engagementReplyClaims.generation))
        .limit(1);
      return row ?? null;
    },
    async countInWindow(socialAccountId, since) {
      const [row] = await exec
        .select({ n: sql<number>`count(*)::int` })
        .from(engagementReplyClaims)
        .where(
          and(
            inProject,
            eq(engagementReplyClaims.socialAccountId, socialAccountId),
            sql`${engagementReplyClaims.claimedAt} >= ${since}`,
          ),
        );
      return row?.n ?? 0;
    },
  };
}
