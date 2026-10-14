// standing-series/run: open or resume a series' current-period run (contracts/services.md §7.1).
import { Temporal } from "@js-temporal/polyfill";
import { boundariesBetween, nextBoundaryAfter, periodStartDate, periodStartInstant, type CadencePeriod } from "@/lib/series/cadence";
import { localToday, nextTargetDate } from "@/lib/series/dated";
import type { DatedPosition, StandingSeriesRunConfig } from "@/lib/validation/standing-series";
import { isUniqueViolation, takeVoice } from "../generation/single";
import type { ProjectScope } from "../../dal/scope";
import type {
  NewStandingSeriesRun,
  StandingSeriesOutcome,
  StandingSeriesPositionStatus,
  StandingSeriesRecord,
  StandingSeriesRunRecord,
} from "../../dal/standing-series";
import { evaluateDatedSeries } from "./dated-due";

/** How many of the most recent closed runs' `outcome` the self-pause check reads (S35). */
export const SELF_PAUSE_RUNS = 3;

export function deriveRunOutcome(counts: { produced: number; requested: number; open: number }): StandingSeriesOutcome {
  if (counts.open > 0) return "incomplete";
  if (counts.produced === 0) return "produced_none";
  if (counts.produced === counts.requested) return "produced_all";
  return "produced_some";
}

/**
 * Three most recent closed runs each produced zero posts (S35, FR-053). Decided on the produced
 * count, not the outcome enum: an `incomplete` run that produced some posts is not "produced
 * nothing" (review F7).
 */
export function shouldSelfPause(recent: readonly { outcome: StandingSeriesOutcome; produced: number }[]): boolean {
  if (recent.length < SELF_PAUSE_RUNS) return false;
  return recent.slice(0, SELF_PAUSE_RUNS).every((r) => r.produced === 0);
}

/**
 * Closes `run` (a no-op if it is already closed) and, when it produced nothing, runs the
 * self-pause check. The one place every run close goes through, so FR-053 applies regardless of
 * which of the run's four close sites reaches it (review F6).
 */
export async function closeRun(
  scope: ProjectScope,
  run: StandingSeriesRunRecord,
  now: Date,
): Promise<{ closed: StandingSeriesRunRecord | null; autoPaused: boolean }> {
  if (run.period === "date") {
    const today = localToday(now, scope.project.timezone);
    if (Temporal.PlainDate.compare(today, Temporal.PlainDate.from(run.periodStart)) > 0) {
      const positions = await scope.standingSeriesPositions.listForRun(run.id);
      for (const position of positions) {
        if (position.status !== "queued" && position.status !== "running") continue;
        await scope.standingSeriesPositions.update(position.id, { status: "missed", finishedAt: now });
        const occurrence = await scope.datedOccurrences.forPosition(position.id);
        if (occurrence) await scope.datedOccurrences.settle(occurrence.id, "missed", now);
      }
    }
  }
  const counts = countsOf(await scope.standingSeriesPositions.countByStatus(run.id), run.requestedCount);
  const outcome = deriveRunOutcome(counts);
  const closed = await scope.standingSeriesRuns.close(run.id, outcome, now);
  if (!closed) return { closed: null, autoPaused: false };
  let autoPaused = false;
  if (outcome === "produced_none" || outcome === "incomplete") {
    const recent = await scope.standingSeriesRuns.recentClosedProduced(run.seriesId, SELF_PAUSE_RUNS);
    if (shouldSelfPause(recent)) {
      await scope.standingSeries.update(run.seriesId, { enabled: false, autoPausedReason: "no_output" });
      autoPaused = true;
    }
  }
  return { closed, autoPaused };
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
    rule: series.occurrenceRule,
    brief: series.brief,
    template: series.template,
    templateFields: series.templateFields,
    voiceProfileId: series.voiceProfileId,
    targetAccountIds: series.targetAccountIds,
    cadence:
      series.occurrenceRule === "cadence" ? { count: series.cadenceCount!, period: series.cadencePeriod as CadencePeriod } : null,
    leadDays: series.leadDays,
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
async function closeStale(scope: ProjectScope, open: StandingSeriesRunRecord, now: Date): Promise<boolean> {
  const { autoPaused } = await closeRun(scope, open, now);
  return autoPaused;
}

/**
 * Opens the current period's run for `series`, or returns the one already open for it. Closes a
 * stale (prior-period) open run first (W11, FR-014). Returns `null` only when there is no open run
 * and the series is not yet due — defensive, since a claim should already guarantee due-ness — or
 * when closing that stale run just auto-paused the series (review F2): opening a fresh run on a
 * series that has just been disabled would leave an orphan that defeats Resume a period later.
 */
export async function openOrResumeRun(
  scope: ProjectScope,
  series: StandingSeriesRecord,
  now: Date,
): Promise<OpenOrResumeResult | null> {
  if (series.occurrenceRule === "dated_list") return openOrResumeDatedRun(scope, series, now);
  const zone = scope.project.timezone;
  const period = series.cadencePeriod as CadencePeriod;
  const currentStart = periodStartDate(now, zone, period);
  const currentStartStr = currentStart.toString();

  let open = await scope.standingSeriesRuns.openFor(series.id);
  const hadOpen = open !== null;
  if (open && open.period === period && open.periodStart === currentStartStr) {
    return { run: open, opened: false };
  }
  if (open) {
    const autoPaused = await closeStale(scope, open, now);
    if (autoPaused) return null;
    open = null;
  }
  if (!hadOpen && series.nextRunAt!.getTime() > now.getTime()) return null;

  const periodStartAt = periodStartInstant(currentStart, zone);
  // `series.nextRunAt` is itself always a boundary (every writer uses `nextBoundaryAfter`); the boundary
  // just before it is the last period the series actually knew about.
  const lastKnownBoundary = periodStartInstant(periodStartDate(new Date(series.nextRunAt!.getTime() - 1), zone, period), zone);
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
    requestedCount: series.cadenceCount!,
    config: configFrom(series),
    missedPeriods: missed,
    droppedAccountIds,
    blockedReason,
  };

  let run: StandingSeriesRunRecord;
  try {
    run = await scope.transaction(async (tx) => {
      const row = await tx.standingSeriesRuns.openRun(insert);
      await tx.standingSeriesPositions.insertMany(row.id, insert.requestedCount, now);
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
    const { closed } = await closeRun(scope, run, now);
    return { run: closed ?? run, opened: true };
  }

  return { run, opened: true };
}

/** The dated branch of `openOrResumeRun` (contracts/services.md §10). */
async function openOrResumeDatedRun(
  scope: ProjectScope,
  series: StandingSeriesRecord,
  now: Date,
): Promise<OpenOrResumeResult | null> {
  const zone = scope.project.timezone;
  const evaluation = await evaluateDatedSeries(scope, series, now);
  const today = localToday(now, zone);

  // Resuming must key off today's local date, not `evaluation.dueDate`: a resumed run's own rows
  // were already advanced past their target when the run opened, so a later tick sees nothing due
  // and would otherwise mistake its own still-open run for a prior period's stale one.
  let open = await scope.standingSeriesRuns.openFor(series.id);
  if (open && open.periodStart === today.toString()) {
    return { run: open, opened: false };
  }
  if (open) {
    const autoPaused = await closeStale(scope, open, now);
    if (autoPaused) return null;
    open = null;
  }
  if (evaluation.dueDate === null) return null;

  const dueDate = evaluation.dueDate;
  const rows = await scope.datedRows.dueOn(series.id, dueDate);
  if (rows.length === 0) return null;

  let blockedReason: "voice_profile_missing" | "no_usable_target" | null = null;
  let droppedAccountIds: string[] = [];
  try {
    await takeVoice(scope, series.voiceProfileId);
  } catch {
    blockedReason = "voice_profile_missing";
  }
  if (!blockedReason) {
    const live = new Set(await loadLiveAccountIds(scope, series.targetAccountIds));
    droppedAccountIds = series.targetAccountIds.filter((id) => !live.has(id));
    if (live.size === 0) blockedReason = "no_usable_target";
  }

  const periodStartAt = periodStartInstant(Temporal.PlainDate.from(dueDate), zone);
  const insert: NewStandingSeriesRun = {
    seriesId: series.id,
    period: "date",
    periodStart: dueDate,
    periodStartAt,
    requestedCount: rows.length,
    config: configFrom(series),
    missedPeriods: 0,
    droppedAccountIds,
    blockedReason,
  };

  let run: StandingSeriesRunRecord;
  try {
    run = await scope.transaction(async (tx) => {
      const row = await tx.standingSeriesRuns.openRun(insert);
      const positions = await tx.standingSeriesPositions.insertMany(row.id, rows.length, now);
      const firedYears = await tx.datedRows.firedYears(rows.map((r) => r.id));
      for (const [index, dueRow] of rows.entries()) {
        const position = positions[index]!;
        const year = Temporal.PlainDate.from(dueDate).year;
        const dated: DatedPosition = {
          v: 1,
          rowId: dueRow.id,
          year,
          targetDate: dueDate,
          keyValue: dueRow.keyValue,
          values: dueRow.fields as Record<string, string>,
          mediaAssetId: dueRow.mediaAssetId,
          mediaFilename: dueRow.mediaFilename,
        };
        await tx.standingSeriesPositions.update(position.id, { dated });
        await tx.datedOccurrences.insert({ seriesId: series.id, rowId: dueRow.id, year, targetDate: dueDate, positionId: position.id });
        const fired = firedYears.get(dueRow.id) ?? [];
        const spec = { month: dueRow.month, day: dueRow.day, year: dueRow.year };
        const next = nextTargetDate(spec, today, [...fired, year]);
        await tx.datedRows.advance(dueRow.id, next ? next.toString() : null, dueRow.nextTargetDate);
      }
      await tx.standingSeries.update(series.id, { lastRunAt: now });
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
      const occurrence = await scope.datedOccurrences.forPosition(position.id);
      if (occurrence) await scope.datedOccurrences.settle(occurrence.id, "skipped", now);
    }
    const { closed } = await closeRun(scope, run, now);
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
