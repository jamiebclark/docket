// standing-series/dated-due: the one answer to "which rows are due" (contracts/services.md §5, B24).
import { Temporal } from "@js-temporal/polyfill";
import { isEligible, localToday, nextTargetDate, type DatedSpec } from "@/lib/series/dated";
import type { ProjectScope } from "../../dal/scope";
import type { StandingSeriesRecord } from "../../dal/standing-series";

export const MISSED_SWEEP_LIMIT = 50; // FR-036
export const MISSED_RECORD_WINDOW_DAYS = 30; // FR-036

export interface DatedEvaluation {
  /** The oldest due target date, "YYYY-MM-DD", or null when nothing is due (A28, FR-037). */
  dueDate: string | null;
  /** Occurrences recorded as missed by this pass. */
  missed: number;
  /** Rows whose `next_target_date` this pass moved forward. */
  retired: number;
}

function specOf(row: { month: number; day: number; year: number | null }): DatedSpec {
  return { month: row.month, day: row.day, year: row.year };
}

/**
 * Retires every row whose window has closed and reports the oldest date still due.
 * Reads `scope.project.timezone` on every call (A32, FR-041) and takes the engine clock's `now`.
 * Called by the producer before opening a run, by `resumeStandingSeries`, and never by a read path.
 */
export async function evaluateDatedSeries(
  scope: ProjectScope,
  series: StandingSeriesRecord,
  now: Date,
): Promise<DatedEvaluation> {
  const zone = scope.project.timezone;
  const today = localToday(now, zone);
  const todayStr = today.toString();

  const rows = await scope.datedRows.dueOrPast(series.id, todayStr, series.leadDays, MISSED_SWEEP_LIMIT);
  if (rows.length === 0) return { dueDate: null, missed: 0, retired: 0 };

  const firedYears = await scope.datedRows.firedYears(rows.map((r) => r.id));

  let missed = 0;
  let retired = 0;
  let dueDate: string | null = null;

  for (const row of rows) {
    const spec = specOf(row);
    const fired = firedYears.get(row.id) ?? [];
    const currentTarget = row.nextTargetDate ? Temporal.PlainDate.from(row.nextTargetDate) : null;

    if (currentTarget && Temporal.PlainDate.compare(currentTarget, today) < 0) {
      const ageDays = today.since(currentTarget, { largestUnit: "day" }).days;
      if (ageDays <= MISSED_RECORD_WINDOW_DAYS) {
        await scope.datedOccurrences.recordMissed({
          seriesId: series.id,
          rowId: row.id,
          year: currentTarget.year,
          targetDate: row.nextTargetDate!,
          at: now,
        });
        missed += 1;
      }
      const next = nextTargetDate(spec, today, [...fired, currentTarget.year]);
      await scope.datedRows.advance(row.id, next ? next.toString() : null, row.nextTargetDate);
      retired += 1;
      if (next && isEligible(next, series.leadDays, today)) {
        const nextStr = next.toString();
        if (dueDate === null || nextStr < dueDate) dueDate = nextStr;
      }
      continue;
    }

    if (currentTarget && isEligible(currentTarget, series.leadDays, today)) {
      const str = currentTarget.toString();
      if (dueDate === null || str < dueDate) dueDate = str;
    }
  }

  return { dueDate, missed, retired };
}
