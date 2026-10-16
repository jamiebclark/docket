import { and, desc, eq, inArray, isNotNull, lt, notExists, or, sql } from "drizzle-orm";
import { getDb, type Database } from "../db/client";
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
  /** Account removal (FR-059): a soft delete does not cascade, so this is explicit. Drafts go with their items. */
  deleteForAccount(socialAccountId: string): Promise<void>;
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
    async deleteForAccount(socialAccountId) {
      await exec.delete(engagementItems).where(and(inProject, eq(engagementItems.socialAccountId, socialAccountId)));
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
  countSendState(state: EngagementDraftRow["sendState"]): Promise<number>;
  listBySendState(state: EngagementDraftRow["sendState"]): Promise<EngagementDraftRow[]>;
  /**
   * `expectedLeaseOwner`, when given, conditions the write on `send_lease_owner` still matching —
   * so a tick whose send lease already expired and was reclaimed by another tick cannot record its
   * own stale outcome over the one that reclaimed it (FR-039, FR-040, SC-004).
   */
  update(
    id: string,
    patch: Partial<Omit<EngagementDraftRow, "id" | "projectId" | "createdAt">>,
    expectedLeaseOwner?: string,
  ): Promise<void>;
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
    async countSendState(state) {
      const [row] = await exec
        .select({ n: sql<number>`count(*)::int` })
        .from(engagementDrafts)
        .where(and(inProject, eq(engagementDrafts.sendState, state)));
      return row?.n ?? 0;
    },
    async listBySendState(state) {
      return exec
        .select()
        .from(engagementDrafts)
        .where(and(inProject, eq(engagementDrafts.sendState, state)))
        .orderBy(desc(engagementDrafts.updatedAt));
    },
    async update(id, patch, expectedLeaseOwner) {
      await exec
        .update(engagementDrafts)
        .set(patch as Record<string, unknown>)
        .where(
          and(
            inProject,
            eq(engagementDrafts.id, id),
            ...(expectedLeaseOwner ? [eq(engagementDrafts.sendLeaseOwner, expectedLeaseOwner)] : []),
          ),
        );
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
  /**
   * `expectedLeaseOwner`, when given, conditions the write on `read_lease_owner` still matching —
   * so a worker whose lease already expired and was reclaimed by another tick cannot clobber that
   * tick's progress with its own stale result (data-model.md §5, FR-007).
   */
  update(
    socialAccountId: string,
    patch: Partial<Omit<EngagementAccountStateRow, "socialAccountId" | "projectId" | "createdAt">>,
    expectedLeaseOwner?: string,
  ): Promise<void>;
  /** Account removal (FR-059): a soft delete does not cascade, so this is explicit. */
  deleteForAccount(socialAccountId: string): Promise<void>;
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
    async update(socialAccountId, patch, expectedLeaseOwner) {
      await exec
        .update(engagementAccountStates)
        .set(patch as Record<string, unknown>)
        .where(
          and(
            inProject,
            eq(engagementAccountStates.socialAccountId, socialAccountId),
            ...(expectedLeaseOwner ? [eq(engagementAccountStates.readLeaseOwner, expectedLeaseOwner)] : []),
          ),
        );
    },
    async deleteForAccount(socialAccountId) {
      await exec.delete(engagementAccountStates).where(and(inProject, eq(engagementAccountStates.socialAccountId, socialAccountId)));
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
}

/**
 * The send ledger (data-model.md §4): never deleted by any code path (research.md §3), and the
 * only write after insert is `release`, which turns a live claim into a released one. A
 * unique-violation on insert means a concurrent attempt already claimed this generation — the
 * whole of FR-039.
 */
export interface EngagementReplyClaimsRepo {
  insert(input: NewEngagementReplyClaim): Promise<void>;
  /** The highest-generation row for this item, or null if never claimed. */
  latest(socialAccountId: string, itemExternalId: string): Promise<EngagementReplyClaimRow | null>;
  /** Marks a still-live claim released, so the item can be claimed again at the next generation. */
  release(
    socialAccountId: string,
    itemExternalId: string,
    generation: number,
    reason: "definite_failure" | "member_decision",
    releasedByUserId: string | null,
    releasedAt: Date,
  ): Promise<void>;
  /** Claims in `[since, now]` for one account — what the write-budget reserve counts (research.md §8). */
  countInWindow(socialAccountId: string, since: Date): Promise<number>;
  /** Account removal (FR-059): a soft delete does not cascade, so this is explicit — the one place the ledger is deleted. */
  deleteForAccount(socialAccountId: string): Promise<void>;
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
    async release(socialAccountId, itemExternalId, generation, reason, releasedByUserId, releasedAt) {
      await exec
        .update(engagementReplyClaims)
        .set({ releasedAt, releaseReason: reason, releasedByUserId })
        .where(
          and(
            inProject,
            eq(engagementReplyClaims.socialAccountId, socialAccountId),
            eq(engagementReplyClaims.itemExternalId, itemExternalId),
            eq(engagementReplyClaims.generation, generation),
          ),
        );
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
    async deleteForAccount(socialAccountId) {
      await exec.delete(engagementReplyClaims).where(and(inProject, eq(engagementReplyClaims.socialAccountId, socialAccountId)));
    },
  };
}

/**
 * Deletes items (and, by cascade, their drafts) that are either withdrawn, regardless of age, or
 * past `before` with no `needs_review` draft and no unresolved `ambiguous` send (data-model.md §10).
 * One bounded batch, cross-project — the ledger is never touched.
 */
export async function pruneEngagementItemsBefore(before: Date, limit: number): Promise<number> {
  const db = getDb();
  const blocked = notExists(
    db
      .select({ one: sql`1` })
      .from(engagementDrafts)
      .where(
        and(
          eq(engagementDrafts.engagementItemId, engagementItems.id),
          or(eq(engagementDrafts.reviewState, "needs_review"), eq(engagementDrafts.sendState, "ambiguous")),
        ),
      ),
  );
  const ids = await db
    .select({ id: engagementItems.id })
    .from(engagementItems)
    .where(or(isNotNull(engagementItems.withdrawnAt), and(lt(engagementItems.saidAt, before), blocked)))
    .limit(limit);
  if (ids.length === 0) return 0;
  const gone = await db
    .delete(engagementItems)
    .where(inArray(engagementItems.id, ids.map((r) => r.id)))
    .returning({ id: engagementItems.id });
  return gone.length;
}
