import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  standingSeries,
  standingSeriesPositions,
  standingSeriesRuns,
  type StandingSeriesPositionRow,
  type StandingSeriesRow,
  type StandingSeriesRunRow,
} from "../db/schema";

export type StandingSeriesRecord = StandingSeriesRow;
export type StandingSeriesRunRecord = StandingSeriesRunRow;
export type StandingSeriesPositionRecord = StandingSeriesPositionRow;
export type StandingSeriesPositionStatus = StandingSeriesPositionRecord["status"];
export type StandingSeriesOutcome = NonNullable<StandingSeriesRunRecord["outcome"]>;

export type NewStandingSeries = Omit<typeof standingSeries.$inferInsert, "id" | "projectId" | "createdAt" | "updatedAt">;
export type StandingSeriesPatch = Partial<
  Pick<
    typeof standingSeries.$inferInsert,
    | "name"
    | "brief"
    | "template"
    | "templateFields"
    | "voiceProfileId"
    | "targetAccountIds"
    | "cadenceCount"
    | "cadencePeriod"
    | "mediaSource"
    | "mediaPoolTag"
    | "imagePrompt"
    | "requestedApproval"
    | "requestedScheduling"
    | "approvalPolicy"
    | "schedulingPolicy"
    | "enabled"
    | "autoPausedReason"
    | "lastRunAt"
    | "nextRunAt"
    | "leaseOwner"
    | "leaseUntil"
    | "lastClaimedAt"
  >
>;

export type NewStandingSeriesRun = Omit<typeof standingSeriesRuns.$inferInsert, "id" | "projectId" | "openedAt" | "closedAt" | "outcome">;
export type StandingSeriesRunPatch = Partial<
  Pick<typeof standingSeriesRuns.$inferInsert, "plan" | "planAttemptCount" | "planNextAttemptAt">
>;

/** A prior run's plan, in the shape `avoidTitles` wants. */
export interface ClosedRunPlan {
  angles: { title: string }[];
}

export type StandingSeriesPositionPatch = Partial<
  Pick<
    typeof standingSeriesPositions.$inferInsert,
    | "status"
    | "mediaAssetId"
    | "attemptCount"
    | "nextAttemptAt"
    | "pendingRetry"
    | "lastErrorKind"
    | "lastError"
    | "skipReason"
    | "skipAccountId"
    | "startedAt"
    | "finishedAt"
  >
>;

const emptyPositionCounts = (): Record<StandingSeriesPositionStatus, number> => ({
  queued: 0,
  running: 0,
  produced: 0,
  failed: 0,
  skipped: 0,
});

export interface StandingSeriesRepo {
  /** Throws (23505) on the name unique index. */
  insert(input: NewStandingSeries): Promise<StandingSeriesRecord>;
  get(id: string): Promise<StandingSeriesRecord | null>;
  /** Ordered by `lower(name)`. */
  list(opts: { page: number; pageSize: number }): Promise<{ rows: StandingSeriesRecord[]; total: number }>;
  update(id: string, patch: StandingSeriesPatch): Promise<StandingSeriesRecord | null>;
  /** `FOR UPDATE` in its own statement (002 D11 rule). */
  lockForUpdate(id: string): Promise<StandingSeriesRecord | null>;
  /** `FOR SHARE`, for the lease-still-held policy guard. */
  lockShared(id: string): Promise<StandingSeriesRecord | null>;
  delete(id: string): Promise<boolean>;
  /** The friendly message before the index fires. */
  nameTaken(name: string, exceptId?: string): Promise<boolean>;
  /** Positions ever `produced` across every run, for the delete confirmation's post count. */
  countProduced(id: string): Promise<number>;
}

export interface StandingSeriesRunsRepo {
  /** Throws (23505) on either the period or the open-run unique index. */
  openRun(input: NewStandingSeriesRun): Promise<StandingSeriesRunRecord>;
  /** `closed_at IS NULL`. */
  openFor(seriesId: string): Promise<StandingSeriesRunRecord | null>;
  get(id: string): Promise<StandingSeriesRunRecord | null>;
  /** `opened_at DESC`. */
  listForSeries(seriesId: string, opts: { limit: number }): Promise<StandingSeriesRunRecord[]>;
  /** Closed runs' plans, newest first, for `avoidTitles` (S30). */
  recentClosedPlans(seriesId: string, limit: number): Promise<ClosedRunPlan[]>;
  /** Closed runs' outcomes, newest first, for the self-pause check (S35). */
  recentClosedOutcomes(seriesId: string, limit: number): Promise<StandingSeriesOutcome[]>;
  update(id: string, patch: StandingSeriesRunPatch): Promise<StandingSeriesRunRecord | null>;
  /** `UPDATE ... WHERE closed_at IS NULL`. */
  close(id: string, outcome: StandingSeriesOutcome, at: Date): Promise<StandingSeriesRunRecord | null>;
  /** `UPDATE ... WHERE plan IS NULL` (S8). `false` means another worker already planned it. */
  setPlan(id: string, plan: { angles: { title: string; description: string }[] }): Promise<boolean>;
}

export interface StandingSeriesPositionsRepo {
  /** `nextAttemptAt` defaults to the engine clock, not the column's own `defaultNow()`, so a pinned test clock is honoured (FR-040). */
  insertMany(runId: string, count: number, nextAttemptAt: Date): Promise<StandingSeriesPositionRecord[]>;
  listForRun(runId: string): Promise<StandingSeriesPositionRecord[]>;
  countByStatus(runId: string): Promise<Record<StandingSeriesPositionStatus, number>>;
  /** `status = 'queued' AND next_attempt_at <= now`, or `status = 'running'`; earliest position first. */
  nextDue(runId: string, now: Date): Promise<StandingSeriesPositionRecord | null>;
  update(id: string, patch: StandingSeriesPositionPatch): Promise<StandingSeriesPositionRecord | null>;
  /** `UPDATE ... WHERE media_asset_id IS NULL`. `false` means the position already held an asset. */
  claimMedia(id: string, assetId: string): Promise<boolean>;
}

export function createStandingSeriesRepo(db: Database, projectId: string): StandingSeriesRepo {
  const mine = (id: string) => and(eq(standingSeries.projectId, projectId), eq(standingSeries.id, id));
  return {
    async insert(input) {
      const [row] = await db
        .insert(standingSeries)
        .values({ ...input, projectId })
        .returning();
      return row!;
    },
    async get(id) {
      const [row] = await db.select().from(standingSeries).where(mine(id)).limit(1);
      return row ?? null;
    },
    async list({ page, pageSize }) {
      const inProject = eq(standingSeries.projectId, projectId);
      const [rows, [count]] = await Promise.all([
        db
          .select()
          .from(standingSeries)
          .where(inProject)
          .orderBy(sql`lower(${standingSeries.name})`, asc(standingSeries.id))
          .limit(pageSize)
          .offset((Math.max(1, page) - 1) * pageSize),
        db.select({ n: sql<number>`count(*)::int` }).from(standingSeries).where(inProject),
      ]);
      return { rows, total: count?.n ?? 0 };
    },
    async update(id, patch) {
      if (Object.keys(patch).length === 0) return this.get(id);
      const [row] = await db.update(standingSeries).set(patch).where(mine(id)).returning();
      return row ?? null;
    },
    async lockForUpdate(id) {
      const [row] = await db.select().from(standingSeries).where(mine(id)).limit(1).for("update");
      return row ?? null;
    },
    async lockShared(id) {
      const [row] = await db.select().from(standingSeries).where(mine(id)).limit(1).for("share");
      return row ?? null;
    },
    async delete(id) {
      const rows = await db.delete(standingSeries).where(mine(id)).returning({ id: standingSeries.id });
      return rows.length > 0;
    },
    async nameTaken(name, exceptId) {
      const conds = [eq(standingSeries.projectId, projectId), sql`lower(${standingSeries.name}) = lower(${name})`];
      if (exceptId) conds.push(sql`${standingSeries.id} <> ${exceptId}`);
      const [row] = await db
        .select({ id: standingSeries.id })
        .from(standingSeries)
        .where(and(...conds))
        .limit(1);
      return row !== undefined;
    },
    async countProduced(id) {
      const [row] = await db
        .select({ n: sql<number>`count(*)` })
        .from(standingSeriesPositions)
        .innerJoin(standingSeriesRuns, eq(standingSeriesRuns.id, standingSeriesPositions.runId))
        .where(
          and(
            eq(standingSeriesPositions.projectId, projectId),
            eq(standingSeriesRuns.projectId, projectId),
            eq(standingSeriesRuns.seriesId, id),
            eq(standingSeriesPositions.status, "produced"),
          ),
        );
      return Number(row?.n ?? 0);
    },
  };
}

export function createStandingSeriesRunsRepo(db: Database, projectId: string): StandingSeriesRunsRepo {
  const mine = (id: string) => and(eq(standingSeriesRuns.projectId, projectId), eq(standingSeriesRuns.id, id));
  const forSeries = (seriesId: string) => and(eq(standingSeriesRuns.projectId, projectId), eq(standingSeriesRuns.seriesId, seriesId));
  return {
    async openRun(input) {
      const [row] = await db
        .insert(standingSeriesRuns)
        .values({ ...input, projectId })
        .returning();
      return row!;
    },
    async openFor(seriesId) {
      const [row] = await db
        .select()
        .from(standingSeriesRuns)
        .where(and(forSeries(seriesId), isNull(standingSeriesRuns.closedAt)))
        .limit(1);
      return row ?? null;
    },
    async get(id) {
      const [row] = await db.select().from(standingSeriesRuns).where(mine(id)).limit(1);
      return row ?? null;
    },
    async listForSeries(seriesId, { limit }) {
      return db
        .select()
        .from(standingSeriesRuns)
        .where(forSeries(seriesId))
        .orderBy(desc(standingSeriesRuns.openedAt), desc(standingSeriesRuns.id))
        .limit(limit);
    },
    async recentClosedPlans(seriesId, limit) {
      const rows = await db
        .select({ plan: standingSeriesRuns.plan })
        .from(standingSeriesRuns)
        .where(and(forSeries(seriesId), sql`${standingSeriesRuns.closedAt} IS NOT NULL`, sql`${standingSeriesRuns.plan} IS NOT NULL`))
        .orderBy(desc(standingSeriesRuns.openedAt), desc(standingSeriesRuns.id))
        .limit(limit);
      return rows.map((r) => r.plan as ClosedRunPlan);
    },
    async recentClosedOutcomes(seriesId, limit) {
      const rows = await db
        .select({ outcome: standingSeriesRuns.outcome })
        .from(standingSeriesRuns)
        .where(and(forSeries(seriesId), sql`${standingSeriesRuns.closedAt} IS NOT NULL`))
        .orderBy(desc(standingSeriesRuns.openedAt), desc(standingSeriesRuns.id))
        .limit(limit);
      return rows.map((r) => r.outcome as StandingSeriesOutcome);
    },
    async update(id, patch) {
      if (Object.keys(patch).length === 0) return this.get(id);
      const [row] = await db.update(standingSeriesRuns).set(patch).where(mine(id)).returning();
      return row ?? null;
    },
    async close(id, outcome, at) {
      const [row] = await db
        .update(standingSeriesRuns)
        .set({ outcome, closedAt: at })
        .where(and(mine(id), isNull(standingSeriesRuns.closedAt)))
        .returning();
      return row ?? null;
    },
    async setPlan(id, plan) {
      const rows = await db
        .update(standingSeriesRuns)
        .set({ plan })
        .where(and(mine(id), isNull(standingSeriesRuns.plan)))
        .returning({ id: standingSeriesRuns.id });
      return rows.length > 0;
    },
  };
}

export function createStandingSeriesPositionsRepo(db: Database, projectId: string): StandingSeriesPositionsRepo {
  const mine = (id: string) => and(eq(standingSeriesPositions.projectId, projectId), eq(standingSeriesPositions.id, id));
  const forRun = (runId: string) => and(eq(standingSeriesPositions.projectId, projectId), eq(standingSeriesPositions.runId, runId));
  return {
    async insertMany(runId, count, nextAttemptAt) {
      if (count <= 0) return [];
      return db
        .insert(standingSeriesPositions)
        .values(
          Array.from({ length: count }, (_, position) => ({
            projectId,
            runId,
            position,
            nextAttemptAt,
          })),
        )
        .returning();
    },
    async listForRun(runId) {
      return db
        .select()
        .from(standingSeriesPositions)
        .where(forRun(runId))
        .orderBy(asc(standingSeriesPositions.position));
    },
    async countByStatus(runId) {
      const rows = await db
        .select({ status: standingSeriesPositions.status, n: sql<number>`count(*)::int` })
        .from(standingSeriesPositions)
        .where(forRun(runId))
        .groupBy(standingSeriesPositions.status);
      const out = emptyPositionCounts();
      for (const r of rows) out[r.status] = r.n;
      return out;
    },
    async nextDue(runId, now) {
      // A CASE, not `OR`: the scope checker treats any `or` in a predicate as disqualifying every
      // equality in the whole WHERE clause from pinning the project (media.ts's same workaround).
      const dueExpr = sql`CASE ${standingSeriesPositions.status} WHEN 'running' THEN true WHEN 'queued' THEN ${standingSeriesPositions.nextAttemptAt} <= ${now} ELSE false END`;
      const [row] = await db
        .select()
        .from(standingSeriesPositions)
        .where(and(forRun(runId), dueExpr))
        .orderBy(asc(standingSeriesPositions.position))
        .limit(1);
      return row ?? null;
    },
    async update(id, patch) {
      if (Object.keys(patch).length === 0) {
        const [row] = await db.select().from(standingSeriesPositions).where(mine(id)).limit(1);
        return row ?? null;
      }
      const [row] = await db.update(standingSeriesPositions).set(patch).where(mine(id)).returning();
      return row ?? null;
    },
    async claimMedia(id, assetId) {
      const rows = await db
        .update(standingSeriesPositions)
        .set({ mediaAssetId: assetId })
        .where(and(mine(id), isNull(standingSeriesPositions.mediaAssetId)))
        .returning({ id: standingSeriesPositions.id });
      return rows.length > 0;
    },
  };
}
