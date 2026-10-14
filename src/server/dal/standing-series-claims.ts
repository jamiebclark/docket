import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { getDb, type Database } from "../db/client";
import { standingSeries, standingSeriesPositions, standingSeriesRuns } from "../db/schema";
import { credentialOwnerFor, resolveBlockedProjectIds, standingSeriesExcludingProjects } from "./credential-owners";
import { gateCreditHolds, rewindCreditProbe } from "./credit-holds";
import { INTERRUPTED_MESSAGE } from "./job-claims";
import { createPostsRepo } from "./posts";
import { crossProject } from "./scope";
import type { StandingSeriesRecord } from "./standing-series";

export interface ClaimedStandingSeries {
  /** After the claim patch. */
  series: StandingSeriesRecord;
  /** The `lease_owner` written by this claim. */
  token: string;
  /** This series' credential owner, from the one named seam. */
  owner: string;
  /** This series is the one a held owner was allowed through as a probe (FR-050). */
  probe: boolean;
  /** The lease had expired. */
  recovered: boolean;
}

export interface StandingSeriesClaimResult {
  series: ClaimedStandingSeries[];
  /** Credential owners that had a hold at claim time. */
  held: string[];
  /** Those granted this tick's probe; `probing ⊆ held`. */
  probing: string[];
}

/**
 * Claims due standing series (contracts/worker.md §3): one transaction, lock up to `limit` series
 * (`SKIP LOCKED`, longest due first), apply the claim patch, and reset every stale `running` position
 * of each claimed series' open run. Never waits.
 */
export function claimDueStandingSeries(opts: {
  now: Date;
  limit: number;
  leaseMs: number;
  maxAttempts: number;
}): Promise<StandingSeriesClaimResult> {
  return crossProject("scheduler: claim due standing series", async () => {
    if (opts.limit <= 0) return { series: [], held: [], probing: [] };
    const { now } = opts;
    // Skipped before touching the shared credit-hold row at all: an install with no enabled series
    // must never contend with the batch job claim for that tick's one probe (S23).
    const [anyEnabled] = await getDb().select({ id: standingSeries.id }).from(standingSeries).where(eq(standingSeries.enabled, true)).limit(1);
    if (!anyEnabled) return { series: [], held: [], probing: [] };
    return getDb().transaction(async (tx) => {
      const exec = tx as unknown as Database;
      const { held, probing } = await gateCreditHolds(exec, now);
      const probingSet = new Set(probing);
      const blocked = held.filter((o) => !probingSet.has(o));
      const candidateProjectIds = (
        await exec
          .selectDistinct({ projectId: standingSeries.projectId })
          .from(standingSeries)
          .where(eq(standingSeries.enabled, true))
      ).map((r) => r.projectId);
      const blockedProjects = await resolveBlockedProjectIds(exec, blocked, candidateProjectIds);

      // A run that still has planning or position work due, even past its series' next_run_at (S7).
      const dueCondition = sql`(
        ${standingSeries.nextRunAt} <= ${now}
        OR EXISTS (
          SELECT 1 FROM "standing_series_runs" r
          WHERE r."project_id" = ${standingSeries.projectId} AND r."series_id" = ${standingSeries.id} AND r."closed_at" IS NULL
            AND (
              (r."requested_count" >= 2 AND r."plan" IS NULL AND (r."plan_next_attempt_at" IS NULL OR r."plan_next_attempt_at" <= ${now}))
              OR EXISTS (
                SELECT 1 FROM "standing_series_positions" p
                WHERE p."project_id" = r."project_id" AND p."run_id" = r."id"
                  AND ((p."status" = 'queued' AND p."next_attempt_at" <= ${now}) OR p."status" = 'running')
              )
            )
        )
      )`;

      const rows = await exec
        .select()
        .from(standingSeries)
        .where(
          and(
            eq(standingSeries.enabled, true),
            sql`(${standingSeries.leaseUntil} IS NULL OR ${standingSeries.leaseUntil} <= ${now})`,
            dueCondition,
            standingSeriesExcludingProjects(blockedProjects.ids, blockedProjects.allBlocked),
          ),
        )
        .orderBy(asc(standingSeries.nextRunAt), sql`${standingSeries.lastClaimedAt} ASC NULLS FIRST`, asc(standingSeries.id))
        .limit(opts.limit)
        .for("update", { skipLocked: true });

      if (rows.length === 0) {
        for (const owner of probing) await rewindCreditProbe(owner, now, exec);
        return { series: [], held, probing };
      }

      const owners = new Map<string, string>();
      for (const row of rows) owners.set(row.id, await credentialOwnerFor(row.projectId, exec));

      const budgetFor = (owner: string) => (probingSet.has(owner) ? 1 : opts.limit);
      const kept: { row: StandingSeriesRecord; owner: string }[] = [];
      const keptPerOwner = new Map<string, number>();
      for (const row of rows) {
        if (kept.length >= opts.limit) break;
        const owner = owners.get(row.id)!;
        const budget = budgetFor(owner);
        const soFar = keptPerOwner.get(owner) ?? 0;
        if (soFar >= budget) continue;
        kept.push({ row, owner });
        keptPerOwner.set(owner, soFar + 1);
      }

      const claimed: ClaimedStandingSeries[] = [];
      for (const { row, owner } of kept) {
        const token = randomUUID();
        const probe = probingSet.has(owner);
        const recovered = row.leaseUntil !== null && row.leaseUntil <= now;
        const leaseUntil = new Date(now.getTime() + opts.leaseMs);
        const [updated] = await exec
          .update(standingSeries)
          .set({ leaseOwner: token, leaseUntil, lastClaimedAt: now })
          .where(eq(standingSeries.id, row.id))
          .returning();
        claimed.push({ series: updated!, token, owner, probe, recovered });

        const [openRun] = await exec
          .select()
          .from(standingSeriesRuns)
          .where(and(eq(standingSeriesRuns.projectId, row.projectId), eq(standingSeriesRuns.seriesId, row.id), isNull(standingSeriesRuns.closedAt)))
          .limit(1);
        if (!openRun) continue;

        const runningPositions = await exec
          .select()
          .from(standingSeriesPositions)
          .where(
            and(
              eq(standingSeriesPositions.projectId, row.projectId),
              eq(standingSeriesPositions.runId, openRun.id),
              eq(standingSeriesPositions.status, "running"),
            ),
          );
        if (runningPositions.length === 0) continue;

        const posts = createPostsRepo(exec, row.projectId);
        for (const position of runningPositions) {
          const post = await posts.findByStandingSeriesPosition(position.id, { includeDeleted: true });
          if (post) continue; // Left running: the producer finishes it with no model call (S34).
          if (probe) {
            // A probe claim must not increment attemptCount and must not fail the position as interrupted (FR-050).
            await exec.update(standingSeriesPositions).set({ status: "queued" }).where(eq(standingSeriesPositions.id, position.id));
          } else if (position.attemptCount + 1 >= opts.maxAttempts) {
            await exec
              .update(standingSeriesPositions)
              .set({ status: "failed", lastErrorKind: "interrupted", lastError: INTERRUPTED_MESSAGE, finishedAt: now })
              .where(eq(standingSeriesPositions.id, position.id));
          } else {
            await exec
              .update(standingSeriesPositions)
              .set({ status: "queued", attemptCount: position.attemptCount + 1, nextAttemptAt: now })
              .where(eq(standingSeriesPositions.id, position.id));
          }
        }
      }

      const keptOwners = new Set(kept.map((k) => k.owner));
      for (const owner of probing) {
        if (!keptOwners.has(owner)) await rewindCreditProbe(owner, now, exec);
      }

      return { series: claimed, held, probing };
    });
  });
}
