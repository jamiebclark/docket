// standing-series/run: open or resume a series' current-period run (contracts/services.md §7.1).
import { boundariesBetween, nextBoundaryAfter, periodStartDate, periodStartInstant } from "@/lib/series/cadence";
import type { StandingSeriesRunConfig } from "@/lib/validation/standing-series";
import { isUniqueViolation, takeVoice } from "../generation/single";
import type { ProjectScope } from "../../dal/scope";
import type {
  NewStandingSeriesRun,
  StandingSeriesOutcome,
  StandingSeriesPositionStatus,
  StandingSeriesRecord,
  StandingSeriesRunRecord,
} from "../../dal/standing-series";

/** How many of the most recent closed runs' `outcome` the self-pause check reads (S35). */
export const SELF_PAUSE_RUNS = 3;

export function deriveRunOutcome(counts: { produced: number; requested: number; open: number }): StandingSeriesOutcome {
  if (counts.open > 0) return "incomplete";
  if (counts.produced === 0) return "produced_none";
  if (counts.produced === counts.requested) return "produced_all";
  return "produced_some";
}

/** Three most recent closed runs all `produced_none` or `incomplete` (S35, FR-053). */
export function shouldSelfPause(recentOutcomes: readonly StandingSeriesOutcome[]): boolean {
  if (recentOutcomes.length < SELF_PAUSE_RUNS) return false;
  return recentOutcomes.slice(0, SELF_PAUSE_RUNS).every((o) => o === "produced_none" || o === "incomplete");
}

function countsOf(
  byStatus: Record<StandingSeriesPositionStatus, number>,
  requested: number,
): { produced: number; requested: number; open: number } {
  return { produced: byStatus.produced, requested, open: byStatus.queued + byStatus.running };
}

function configFrom(series: StandingSeriesRecord): StandingSeriesRunConfig {
  return {
    v: 1,
    brief: series.brief,
    template: series.template,
    templateFields: series.templateFields,
    voiceProfileId: series.voiceProfileId,
    targetAccountIds: series.targetAccountIds,
    cadence: { count: series.cadenceCount, period: series.cadencePeriod },
    media:
      series.mediaSource === "pool"
        ? { source: "pool", tag: series.mediaPoolTag ?? null }
        : series.mediaSource === "generate"
          ? { source: "generate", prompt: series.imagePrompt! }
          : { source: "none" },
    requested: { approval: series.requestedApproval, scheduling: series.requestedScheduling },
    resolved: { approval: series.approvalPolicy, scheduling: series.schedulingPolicy },
  };
}

export interface OpenOrResumeResult {
  run: StandingSeriesRunRecord;
  /** This call inserted the run; `false` for an already-open run or one another worker just won. */
  opened: boolean;
}

/** Closes a stale open run (a prior period's) as its own outcome, never relabelling anything else. */
async function closeStale(scope: ProjectScope, open: StandingSeriesRunRecord, now: Date): Promise<void> {
  const counts = countsOf(await scope.standingSeriesPositions.countByStatus(open.id), open.requestedCount);
  await scope.standingSeriesRuns.close(open.id, deriveRunOutcome(counts), now);
}

/**
 * Opens the current period's run for `series`, or returns the one already open for it. Closes a
 * stale (prior-period) open run first (W11, FR-014). Returns `null` only when there is no open run
 * and the series is not yet due — defensive, since a claim should already guarantee due-ness.
 */
export async function openOrResumeRun(
  scope: ProjectScope,
  series: StandingSeriesRecord,
  now: Date,
): Promise<OpenOrResumeResult | null> {
  const zone = scope.project.timezone;
  const period = series.cadencePeriod;
  const currentStart = periodStartDate(now, zone, period);
  const currentStartStr = currentStart.toString();

  let open = await scope.standingSeriesRuns.openFor(series.id);
  const hadOpen = open !== null;
  if (open && open.period === period && open.periodStart === currentStartStr) {
    return { run: open, opened: false };
  }
  if (open) {
    await closeStale(scope, open, now);
    open = null;
  }
  if (!hadOpen && series.nextRunAt.getTime() > now.getTime()) return null;

  const periodStartAt = periodStartInstant(currentStart, zone);
  // `series.nextRunAt` is itself always a boundary (every writer uses `nextBoundaryAfter`); the boundary
  // just before it is the last period the series actually knew about.
  const lastKnownBoundary = periodStartInstant(periodStartDate(new Date(series.nextRunAt.getTime() - 1), zone, period), zone);
  const missed = Math.max(0, boundariesBetween(lastKnownBoundary, now, zone, period) - 1);

  let blockedReason: "voice_profile_missing" | "no_usable_target" | null = null;
  let droppedAccountIds: string[] = [];
  try {
    await takeVoice(scope, series.voiceProfileId);
  } catch {
    blockedReason = "voice_profile_missing";
  }
  if (!blockedReason) {
    const live = new Set((await loadLiveAccountIds(scope, series.targetAccountIds)));
    droppedAccountIds = series.targetAccountIds.filter((id) => !live.has(id));
    if (live.size === 0) blockedReason = "no_usable_target";
  }

  const insert: NewStandingSeriesRun = {
    seriesId: series.id,
    period,
    periodStart: currentStartStr,
    periodStartAt,
    requestedCount: series.cadenceCount,
    config: configFrom(series),
    missedPeriods: missed,
    droppedAccountIds,
    blockedReason,
  };

  let run: StandingSeriesRunRecord;
  try {
    run = await scope.transaction(async (tx) => {
      const row = await tx.standingSeriesRuns.openRun(insert);
      await tx.standingSeriesPositions.insertMany(row.id, insert.requestedCount);
      await tx.standingSeries.update(series.id, {
        lastRunAt: now,
        nextRunAt: nextBoundaryAfter(periodStartAt, zone, period),
      });
      return row;
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const winner = await scope.standingSeriesRuns.openFor(series.id);
    if (winner) return { run: winner, opened: false };
    throw error;
  }

  if (blockedReason) {
    const positions = await scope.standingSeriesPositions.listForRun(run.id);
    for (const position of positions) {
      await scope.standingSeriesPositions.update(position.id, { status: "skipped", skipReason: "series_not_runnable" });
    }
    const closed = await scope.standingSeriesRuns.close(run.id, "produced_none", now);
    return { run: closed ?? run, opened: true };
  }

  return { run, opened: true };
}

/** Live accounts among `ids`, in no particular order; a deleted account is simply absent. */
async function loadLiveAccountIds(scope: ProjectScope, ids: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const id of ids) {
    if (await scope.accounts.get(id)) out.push(id);
  }
  return out;
}
