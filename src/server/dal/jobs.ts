import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  generationJobItems,
  generationJobs,
  type GenerationJobItemRow,
  type GenerationJobRow,
} from "../db/schema";

export type JobRecord = GenerationJobRow;
export type JobItemRecord = GenerationJobItemRow;
export type JobStatus = JobRecord["status"];
export type JobItemStatus = JobItemRecord["status"];

export type NewJob = Omit<typeof generationJobs.$inferInsert, "id" | "projectId" | "createdAt" | "updatedAt">;
export type JobPatch = Partial<
  Pick<
    typeof generationJobs.$inferInsert,
    | "status"
    | "itemCount"
    | "startedAt"
    | "finishedAt"
    | "cancelledAt"
    | "cancelledByUserId"
    | "lastClaimedAt"
  >
>;
export type NewJobItem = Pick<typeof generationJobItems.$inferInsert, "position" | "label" | "payload"> &
  Partial<Pick<typeof generationJobItems.$inferInsert, "mediaAssetId" | "nextAttemptAt">>;
export type JobItemPatch = Partial<
  Pick<
    typeof generationJobItems.$inferInsert,
    | "status"
    | "attemptCount"
    | "nextAttemptAt"
    | "leaseOwner"
    | "leaseUntil"
    | "pendingRetry"
    | "lastErrorKind"
    | "lastError"
    | "startedAt"
    | "finishedAt"
  >
>;

export interface JobCounts {
  queued: number;
  running: number;
  done: number;
  failed: number;
  cancelled: number;
}

const emptyCounts = (): JobCounts => ({ queued: 0, running: 0, done: 0, failed: 0, cancelled: 0 });

export interface JobsRepo {
  insert(input: NewJob): Promise<JobRecord>;
  get(id: string): Promise<JobRecord | null>;
  /** `FOR UPDATE` in its own statement (002 D11 rule). */
  lockForUpdate(id: string): Promise<JobRecord | null>;
  lockShared(id: string): Promise<JobRecord | null>;
  /** Newest first, keyset-free paging by offset. */
  list(opts: { limit: number; offset: number }): Promise<{ rows: JobRecord[]; total: number }>;
  countsFor(jobIds: readonly string[]): Promise<Map<string, JobCounts>>;
  update(id: string, patch: JobPatch): Promise<JobRecord | null>;
}

export interface JobItemsRepo {
  insertMany(jobId: string, items: readonly NewJobItem[]): Promise<JobItemRecord[]>;
  get(id: string): Promise<JobItemRecord | null>;
  listForJob(jobId: string, opts?: { status?: JobItemStatus; limit?: number; offset?: number }): Promise<JobItemRecord[]>;
  countByStatus(jobId: string): Promise<JobCounts>;
  /** Unconditional patch; only for code that holds the row lock (the claim). Lease holders use `updateWithLease`. */
  update(id: string, patch: JobItemPatch): Promise<JobItemRecord>;
  /** Writes only when the item is `running` and still leased to `token`; null means the lease was lost. */
  updateWithLease(id: string, token: string, patch: JobItemPatch): Promise<JobItemRecord | null>;
  /** Failed items of the job (all, or one id) back to `queued` with a fresh attempt budget. Returns the ids. */
  retryFailed(jobId: string, now: Date, itemId?: string): Promise<string[]>;
  /** Cancels queued, failed and running items that have no post yet, clearing leases. Returns the count. */
  cancelForJob(jobId: string, now: Date): Promise<number>;
}

export function createJobsRepo(db: Database, projectId: string): JobsRepo {
  const inProject = eq(generationJobs.projectId, projectId);
  const mine = (id: string) => and(inProject, eq(generationJobs.id, id));
  return {
    async insert(input) {
      const [row] = await db
        .insert(generationJobs)
        .values({ ...input, projectId })
        .returning();
      return row!;
    },
    async get(id) {
      const [row] = await db.select().from(generationJobs).where(mine(id)).limit(1);
      return row ?? null;
    },
    async lockForUpdate(id) {
      const [row] = await db.select().from(generationJobs).where(mine(id)).limit(1).for("update");
      return row ?? null;
    },
    async lockShared(id) {
      const [row] = await db.select().from(generationJobs).where(mine(id)).limit(1).for("share");
      return row ?? null;
    },
    async list({ limit, offset }) {
      const [rows, [count]] = await Promise.all([
        db
          .select()
          .from(generationJobs)
          .where(inProject)
          .orderBy(desc(generationJobs.createdAt), desc(generationJobs.id))
          .limit(limit)
          .offset(offset),
        db.select({ n: sql<number>`count(*)::int` }).from(generationJobs).where(inProject),
      ]);
      return { rows, total: count?.n ?? 0 };
    },
    async countsFor(jobIds) {
      const out = new Map<string, JobCounts>();
      if (jobIds.length === 0) return out;
      const rows = await db
        .select({
          jobId: generationJobItems.jobId,
          status: generationJobItems.status,
          n: sql<number>`count(*)::int`,
        })
        .from(generationJobItems)
        .where(and(eq(generationJobItems.projectId, projectId), inArray(generationJobItems.jobId, [...jobIds])))
        .groupBy(generationJobItems.jobId, generationJobItems.status);
      for (const id of jobIds) out.set(id, emptyCounts());
      for (const r of rows) out.get(r.jobId)![r.status] = r.n;
      return out;
    },
    async update(id, patch) {
      if (Object.keys(patch).length === 0) return this.get(id);
      const [row] = await db.update(generationJobs).set(patch).where(mine(id)).returning();
      return row ?? null;
    },
  };
}

export function createJobItemsRepo(db: Database, projectId: string): JobItemsRepo {
  const inProject = eq(generationJobItems.projectId, projectId);
  const inJob = (jobId: string) => and(inProject, eq(generationJobItems.jobId, jobId));
  const mine = (id: string) => and(inProject, eq(generationJobItems.id, id));
  return {
    async insertMany(jobId, items) {
      if (items.length === 0) return [];
      return db
        .insert(generationJobItems)
        .values(items.map((i) => ({ ...i, projectId, jobId })))
        .returning();
    },
    async get(id) {
      const [row] = await db.select().from(generationJobItems).where(mine(id)).limit(1);
      return row ?? null;
    },
    async listForJob(jobId, opts) {
      const where = opts?.status ? and(inJob(jobId), eq(generationJobItems.status, opts.status)) : inJob(jobId);
      return db
        .select()
        .from(generationJobItems)
        .where(where)
        .orderBy(asc(generationJobItems.position))
        .limit(opts?.limit ?? 500)
        .offset(opts?.offset ?? 0);
    },
    async countByStatus(jobId) {
      const rows = await db
        .select({ status: generationJobItems.status, n: sql<number>`count(*)::int` })
        .from(generationJobItems)
        .where(inJob(jobId))
        .groupBy(generationJobItems.status);
      const out = emptyCounts();
      for (const r of rows) out[r.status] = r.n;
      return out;
    },
    async update(id, patch) {
      const [row] = await db.update(generationJobItems).set(patch).where(mine(id)).returning();
      if (!row) throw new Error("Job item not found");
      return row;
    },
    async updateWithLease(id, token, patch) {
      const [row] = await db
        .update(generationJobItems)
        .set(patch)
        .where(and(mine(id), eq(generationJobItems.status, "running"), eq(generationJobItems.leaseOwner, token)))
        .returning();
      return row ?? null;
    },
    async retryFailed(jobId, now, itemId) {
      const where = and(inJob(jobId), eq(generationJobItems.status, "failed"), itemId ? eq(generationJobItems.id, itemId) : undefined);
      const rows = await db
        .update(generationJobItems)
        .set({ status: "queued", attemptCount: 0, nextAttemptAt: now, pendingRetry: null, finishedAt: null })
        .where(where)
        .returning({ id: generationJobItems.id });
      return rows.map((r) => r.id);
    },
    async cancelForJob(jobId, now) {
      const rows = await db
        .update(generationJobItems)
        .set({
          status: "cancelled",
          leaseOwner: null,
          leaseUntil: null,
          pendingRetry: null,
          finishedAt: now,
        })
        .where(
          and(
            inJob(jobId),
            inArray(generationJobItems.status, ["queued", "failed", "running"]),
            // A running item that already saved its post finishes on its own (it becomes `done`).
            sql`(SELECT count(*) FROM "posts" p WHERE p."project_id" = ${projectId} AND p."generation_job_item_id" = "generation_job_items"."id") = 0`,
          ),
        )
        .returning({ id: generationJobItems.id });
      // An item that already saved its post is finished as `done` (post kept, left in
      // review): once the job is cancelled no tick claims it again, so waiting for it to
      // "finish on its own" left it running forever (F3).
      await db
        .update(generationJobItems)
        .set({ status: "done", leaseOwner: null, leaseUntil: null, pendingRetry: null, finishedAt: now })
        .where(
          and(
            inJob(jobId),
            inArray(generationJobItems.status, ["queued", "running"]),
            sql`(SELECT count(*) FROM "posts" p WHERE p."project_id" = ${projectId} AND p."generation_job_item_id" = "generation_job_items"."id") > 0`,
          ),
        );
      return rows.length;
    },
  };
}

