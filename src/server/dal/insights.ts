import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb, type Database } from "../db/client";
import {
  accountMetricPollStates,
  accountMetricSnapshots,
  postMetricPollStates,
  postMetricSnapshots,
  type AccountMetricPollStateRow,
  type AccountMetricSnapshotRow,
  type NewAccountMetricSnapshot,
  type NewPostMetricSnapshot,
  type PostMetricPollStateRow,
  type PostMetricSnapshotRow,
} from "../db/schema";

export type {
  AccountMetricPollStateRow,
  AccountMetricSnapshotRow,
  NewAccountMetricSnapshot,
  NewPostMetricSnapshot,
  PostMetricPollStateRow,
  PostMetricSnapshotRow,
} from "../db/schema";

/** Append-only by the DAL's shape, not a trigger (data-model.md §1, FR-016): no `update`, no single-row `delete`. */
export interface PostMetricSnapshotsRepo {
  /** `ON CONFLICT DO NOTHING` on `(project_id, post_target_id, captured_at)` (FR-017). */
  insertIfAbsent(input: Omit<NewPostMetricSnapshot, "projectId" | "id" | "createdAt">): Promise<{ id: string; inserted: boolean }>;
  /** The newest snapshot per target, for the panel. One query for a post's whole target list. */
  latestForTargets(postTargetIds: readonly string[]): Promise<Map<string, PostMetricSnapshotRow>>;
  /** `COUNT(*)` for the allowance window (research.md §4). */
  countForAccountSince(socialAccountId: string, since: Date): Promise<number>;
}

export function createPostMetricSnapshotsRepo(exec: Database, projectId: string): PostMetricSnapshotsRepo {
  const inProject = eq(postMetricSnapshots.projectId, projectId);
  return {
    async insertIfAbsent(input) {
      const [row] = await exec
        .insert(postMetricSnapshots)
        .values({ projectId, ...input })
        .onConflictDoNothing({ target: [postMetricSnapshots.projectId, postMetricSnapshots.postTargetId, postMetricSnapshots.capturedAt] })
        .returning({ id: postMetricSnapshots.id });
      if (row) return { id: row.id, inserted: true };
      const [existing] = await exec
        .select({ id: postMetricSnapshots.id })
        .from(postMetricSnapshots)
        .where(and(inProject, eq(postMetricSnapshots.postTargetId, input.postTargetId), eq(postMetricSnapshots.capturedAt, input.capturedAt)))
        .limit(1);
      return { id: existing!.id, inserted: false };
    },
    async latestForTargets(postTargetIds) {
      const result = new Map<string, PostMetricSnapshotRow>();
      if (postTargetIds.length === 0) return result;
      const rows = await exec
        .select()
        .from(postMetricSnapshots)
        .where(and(inProject, inArray(postMetricSnapshots.postTargetId, [...postTargetIds])))
        .orderBy(desc(postMetricSnapshots.capturedAt));
      for (const row of rows) if (!result.has(row.postTargetId)) result.set(row.postTargetId, row);
      return result;
    },
    async countForAccountSince(socialAccountId, since) {
      const [row] = await exec
        .select({ n: sql<number>`count(*)::int` })
        .from(postMetricSnapshots)
        .where(and(inProject, eq(postMetricSnapshots.socialAccountId, socialAccountId), gte(postMetricSnapshots.capturedAt, since)));
      return row?.n ?? 0;
    },
  };
}

export interface AccountMetricSnapshotsRepo {
  insertIfAbsent(input: Omit<NewAccountMetricSnapshot, "projectId" | "id" | "createdAt">): Promise<{ id: string; inserted: boolean }>;
  latestForAccounts(socialAccountIds: readonly string[]): Promise<Map<string, AccountMetricSnapshotRow>>;
  countForAccountSince(socialAccountId: string, since: Date): Promise<number>;
}

export function createAccountMetricSnapshotsRepo(exec: Database, projectId: string): AccountMetricSnapshotsRepo {
  const inProject = eq(accountMetricSnapshots.projectId, projectId);
  return {
    async insertIfAbsent(input) {
      const [row] = await exec
        .insert(accountMetricSnapshots)
        .values({ projectId, ...input })
        .onConflictDoNothing({ target: [accountMetricSnapshots.projectId, accountMetricSnapshots.socialAccountId, accountMetricSnapshots.capturedAt] })
        .returning({ id: accountMetricSnapshots.id });
      if (row) return { id: row.id, inserted: true };
      const [existing] = await exec
        .select({ id: accountMetricSnapshots.id })
        .from(accountMetricSnapshots)
        .where(and(inProject, eq(accountMetricSnapshots.socialAccountId, input.socialAccountId), eq(accountMetricSnapshots.capturedAt, input.capturedAt)))
        .limit(1);
      return { id: existing!.id, inserted: false };
    },
    async latestForAccounts(socialAccountIds) {
      const result = new Map<string, AccountMetricSnapshotRow>();
      if (socialAccountIds.length === 0) return result;
      const rows = await exec
        .select()
        .from(accountMetricSnapshots)
        .where(and(inProject, inArray(accountMetricSnapshots.socialAccountId, [...socialAccountIds])))
        .orderBy(desc(accountMetricSnapshots.capturedAt));
      for (const row of rows) if (!result.has(row.socialAccountId)) result.set(row.socialAccountId, row);
      return result;
    },
    async countForAccountSince(socialAccountId, since) {
      const [row] = await exec
        .select({ n: sql<number>`count(*)::int` })
        .from(accountMetricSnapshots)
        .where(and(inProject, eq(accountMetricSnapshots.socialAccountId, socialAccountId), gte(accountMetricSnapshots.capturedAt, since)));
      return row?.n ?? 0;
    },
  };
}

export type PostPollStatePatch = Partial<Omit<PostMetricPollStateRow, "postTargetId" | "projectId" | "socialAccountId" | "createdAt">>;

export interface PostMetricPollStatesRepo {
  get(postTargetId: string): Promise<PostMetricPollStateRow | null>;
  /** For the panel: one query for a post's whole target list. */
  getMany(postTargetIds: readonly string[]): Promise<Map<string, PostMetricPollStateRow>>;
  /** `expectedLeaseOwner` conditions the write on the lease still being ours (077's stale-result guard). */
  update(postTargetId: string, patch: PostPollStatePatch, expectedLeaseOwner?: string): Promise<void>;
  /** Account removal: a soft delete does not cascade, so this is explicit (as `EngagementAccountStatesRepo`). */
  deleteForAccount(socialAccountId: string): Promise<void>;
}

export function createPostMetricPollStatesRepo(exec: Database, projectId: string): PostMetricPollStatesRepo {
  const inProject = eq(postMetricPollStates.projectId, projectId);
  return {
    async get(postTargetId) {
      const [row] = await exec
        .select()
        .from(postMetricPollStates)
        .where(and(inProject, eq(postMetricPollStates.postTargetId, postTargetId)))
        .limit(1);
      return row ?? null;
    },
    async getMany(postTargetIds) {
      const result = new Map<string, PostMetricPollStateRow>();
      if (postTargetIds.length === 0) return result;
      const rows = await exec
        .select()
        .from(postMetricPollStates)
        .where(and(inProject, inArray(postMetricPollStates.postTargetId, [...postTargetIds])));
      for (const row of rows) result.set(row.postTargetId, row);
      return result;
    },
    async update(postTargetId, patch, expectedLeaseOwner) {
      await exec
        .update(postMetricPollStates)
        .set(patch as Record<string, unknown>)
        .where(
          and(
            inProject,
            eq(postMetricPollStates.postTargetId, postTargetId),
            ...(expectedLeaseOwner ? [eq(postMetricPollStates.pollLeaseOwner, expectedLeaseOwner)] : []),
          ),
        );
    },
    async deleteForAccount(socialAccountId) {
      await exec.delete(postMetricPollStates).where(and(inProject, eq(postMetricPollStates.socialAccountId, socialAccountId)));
    },
  };
}

export type AccountPollStatePatch = Partial<Omit<AccountMetricPollStateRow, "socialAccountId" | "projectId" | "createdAt">>;

export interface AccountMetricPollStatesRepo {
  get(socialAccountId: string): Promise<AccountMetricPollStateRow | null>;
  getMany(socialAccountIds: readonly string[]): Promise<Map<string, AccountMetricPollStateRow>>;
  update(socialAccountId: string, patch: AccountPollStatePatch, expectedLeaseOwner?: string): Promise<void>;
  deleteForAccount(socialAccountId: string): Promise<void>;
}

export function createAccountMetricPollStatesRepo(exec: Database, projectId: string): AccountMetricPollStatesRepo {
  const inProject = eq(accountMetricPollStates.projectId, projectId);
  return {
    async get(socialAccountId) {
      const [row] = await exec
        .select()
        .from(accountMetricPollStates)
        .where(and(inProject, eq(accountMetricPollStates.socialAccountId, socialAccountId)))
        .limit(1);
      return row ?? null;
    },
    async getMany(socialAccountIds) {
      const result = new Map<string, AccountMetricPollStateRow>();
      if (socialAccountIds.length === 0) return result;
      const rows = await exec
        .select()
        .from(accountMetricPollStates)
        .where(and(inProject, inArray(accountMetricPollStates.socialAccountId, [...socialAccountIds])));
      for (const row of rows) result.set(row.socialAccountId, row);
      return result;
    },
    async update(socialAccountId, patch, expectedLeaseOwner) {
      await exec
        .update(accountMetricPollStates)
        .set(patch as Record<string, unknown>)
        .where(
          and(
            inProject,
            eq(accountMetricPollStates.socialAccountId, socialAccountId),
            ...(expectedLeaseOwner ? [eq(accountMetricPollStates.pollLeaseOwner, expectedLeaseOwner)] : []),
          ),
        );
    },
    async deleteForAccount(socialAccountId) {
      await exec.delete(accountMetricPollStates).where(and(inProject, eq(accountMetricPollStates.socialAccountId, socialAccountId)));
    },
  };
}

/** Bounded batch delete, cross-project, after `pruneEngagementItemsBefore` (data-model.md §11). */
export async function prunePostMetricSnapshotsBefore(before: Date, limit: number): Promise<number> {
  const db = getDb();
  const ids = await db
    .select({ id: postMetricSnapshots.id })
    .from(postMetricSnapshots)
    .where(sql`${postMetricSnapshots.capturedAt} < ${before}`)
    .limit(limit);
  if (ids.length === 0) return 0;
  const gone = await db
    .delete(postMetricSnapshots)
    .where(inArray(postMetricSnapshots.id, ids.map((r) => r.id)))
    .returning({ id: postMetricSnapshots.id });
  return gone.length;
}

export async function pruneAccountMetricSnapshotsBefore(before: Date, limit: number): Promise<number> {
  const db = getDb();
  const ids = await db
    .select({ id: accountMetricSnapshots.id })
    .from(accountMetricSnapshots)
    .where(sql`${accountMetricSnapshots.capturedAt} < ${before}`)
    .limit(limit);
  if (ids.length === 0) return 0;
  const gone = await db
    .delete(accountMetricSnapshots)
    .where(inArray(accountMetricSnapshots.id, ids.map((r) => r.id)))
    .returning({ id: accountMetricSnapshots.id });
  return gone.length;
}
