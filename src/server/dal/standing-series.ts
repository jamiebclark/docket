import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, notExists, sql } from "drizzle-orm";
import { getDb, type Database } from "../db/client";
import {
  posts,
  standingSeries,
  standingSeriesOccurrences,
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
  Omit<
    Pick<
      typeof standingSeries.$inferInsert,
      | "name"
      | "brief"
      | "template"
      | "templateFields"
      | "voiceProfileId"
      | "targetAccountIds"
      | "occurrenceRule"
      | "leadDays"
      | "listVersion"
      | "lastImportAt"
      | "lastImportFilename"
      | "lastImportRowCount"
      | "lastImportProblems"
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
    >,
    "nextRunAt"
  > & { nextRunAt: Date | null }
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
    | "dated"
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
  missed: 0,
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
  /** `UPDATE … SET list_version = list_version + 1 WHERE id = ? AND list_version = ?` (B21). */
  bumpListVersion(id: string, expected: number): Promise<boolean>;
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
  /** Closed runs' outcomes, newest first, for the series-list "last run" badge. */
  recentClosedOutcomes(seriesId: string, limit: number): Promise<StandingSeriesOutcome[]>;
  /** Closed runs' outcome plus produced-post count, newest first, for the self-pause check (S35, review F7). */
  recentClosedProduced(seriesId: string, limit: number): Promise<{ outcome: StandingSeriesOutcome; produced: number }[]>;
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
    async bumpListVersion(id, expected) {
      const rows = await db
        .update(standingSeries)
        .set({ listVersion: expected + 1 })
        .where(and(mine(id), eq(standingSeries.listVersion, expected)))
        .returning({ id: standingSeries.id });
      return rows.length > 0;
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
    async recentClosedProduced(seriesId, limit) {
      const runs = await db
        .select({ id: standingSeriesRuns.id, outcome: standingSeriesRuns.outcome })
        .from(standingSeriesRuns)
        .where(and(forSeries(seriesId), sql`${standingSeriesRuns.closedAt} IS NOT NULL`))
        .orderBy(desc(standingSeriesRuns.openedAt), desc(standingSeriesRuns.id))
        .limit(limit);
      if (runs.length === 0) return [];
      const producedRows = await db
        .select({ runId: standingSeriesPositions.runId, n: sql<number>`count(*)::int` })
        .from(standingSeriesPositions)
        .where(
          and(
            eq(standingSeriesPositions.projectId, projectId),
            inArray(standingSeriesPositions.runId, runs.map((r) => r.id)),
            eq(standingSeriesPositions.status, "produced"),
          ),
        )
        .groupBy(standingSeriesPositions.runId);
      const producedByRun = new Map(producedRows.map((r) => [r.runId, r.n]));
      return runs.map((r) => ({ outcome: r.outcome as StandingSeriesOutcome, produced: producedByRun.get(r.id) ?? 0 }));
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

/**
 * `posts(project_id, standing_series_position_id)` references a position through a composite key
 * (FR-057's traceability), and Postgres has no per-column `SET NULL` for a composite foreign key —
 * deleting a still-referenced position would null `project_id` too and fail its `NOT NULL`. Clearing
 * the link first, for every post under the given runs, leaves the cascade below nothing to act on.
 */
async function clearPostLinksForRuns(exec: Database, runIds: readonly string[], projectId?: string): Promise<void> {
  if (runIds.length === 0) return;
  const positionIds = exec
    .select({ id: standingSeriesPositions.id })
    .from(standingSeriesPositions)
    .where(
      and(
        inArray(standingSeriesPositions.runId, runIds as string[]),
        projectId ? eq(standingSeriesPositions.projectId, projectId) : undefined,
      ),
    );
  await exec
    .update(posts)
    .set({ standingSeriesPositionId: null })
    .where(
      and(
        inArray(posts.standingSeriesPositionId, positionIds),
        projectId ? eq(posts.projectId, projectId) : undefined,
      ),
    );
}

/** Clears every post's link to a position under any run of `seriesId`, before the series cascades away. */
export async function clearPostLinksForSeries(exec: Database, projectId: string, seriesId: string): Promise<void> {
  const runs = await exec
    .select({ id: standingSeriesRuns.id })
    .from(standingSeriesRuns)
    .where(and(eq(standingSeriesRuns.projectId, projectId), eq(standingSeriesRuns.seriesId, seriesId)));
  await clearPostLinksForRuns(exec, runs.map((r) => r.id), projectId);
}

/**
 * Housekeeping: deletes at most `limit` closed runs older than `before`; positions and their
 * `generation_failures` cascade. An open run (`closedAt IS NULL`) is never matched. Callers wrap
 * this in `crossProject` (contracts/worker.md §6).
 */
export async function pruneClosedStandingSeriesRunsBefore(before: Date, limit: number): Promise<number> {
  const db = getDb();
  const ids = await db
    .select({ id: standingSeriesRuns.id })
    .from(standingSeriesRuns)
    .where(
      and(
        isNotNull(standingSeriesRuns.closedAt),
        lt(standingSeriesRuns.closedAt, before),
        // Skip a run whose positions a PENDING occurrence still cites, or this delete throws.
        //
        // Deleting the run cascades to its positions, and that nulls
        // `standing_series_occurrences.position_id`. For a settled occurrence that is fine, but
        // `standing_series_occurrences_pending_has_position` requires an occurrence with no outcome to
        // keep a position — so the cascade violates it and the whole statement fails with 23514,
        // taking the housekeeping section of the tick down with it. Reproduced directly: a closed run
        // older than the cutoff whose position one pending occurrence cites.
        //
        // Deferring rather than deleting is deliberate. The alternative is cascading occurrences away
        // with their run, which would discard settled history too, and a pending occurrence is by
        // definition still in use. A run therefore stays until its occurrences settle; one that never
        // settles pins its run, which is a retention cost rather than a correctness one.
        notExists(
          db
            .select({ one: sql`1` })
            .from(standingSeriesOccurrences)
            .innerJoin(standingSeriesPositions, eq(standingSeriesOccurrences.positionId, standingSeriesPositions.id))
            .where(and(eq(standingSeriesPositions.runId, standingSeriesRuns.id), isNull(standingSeriesOccurrences.outcome))),
        ),
      ),
    )
    .limit(limit);
  if (ids.length === 0) return 0;
  const runIds = ids.map((r) => r.id);
  await clearPostLinksForRuns(db, runIds);
  const gone = await db
    .delete(standingSeriesRuns)
    .where(inArray(standingSeriesRuns.id, runIds))
    .returning({ id: standingSeriesRuns.id });
  return gone.length;
}
