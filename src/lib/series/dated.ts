// Pure, the whole of a dated series' date rules: no database, no `Date.now()`.

import { Temporal } from "@js-temporal/polyfill";
import { JOB_ITEMS_MAX } from "@/lib/validation/jobs";
import { CADENCE_COUNT_MAX, periodStartInstant } from "./cadence";

export const DATED_ROWS_MAX = JOB_ITEMS_MAX; // 500 — re-exported, never redefined
export const DATED_ROWS_PER_DATE_MAX = CADENCE_COUNT_MAX; // 10 — the run's own position cap
export const LEAD_DAYS_MIN = 0;
export const LEAD_DAYS_MAX = 30;
export const RESERVED_COLUMNS = ["date", "media"] as const;

/** A row's date: a month and day, optionally pinned to a year. */
export interface DatedSpec {
  month: number;
  day: number;
  year: number | null;
}

export type DateParseError = "format" | "impossible";

const MM_DD = /^(\d{2})-(\d{2})$/;
const YYYY_MM_DD = /^(\d{4})-(\d{2})-(\d{2})$/;

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isImpossible(month: number, day: number): boolean {
  if (month < 1 || month > 12) return true;
  if (day < 1) return true;
  return day > (DAYS_IN_MONTH[month - 1] ?? 0);
}

/** `MM-DD` or `YYYY-MM-DD`, zero-padded, hyphens only, after trimming (A9, FR-011). */
export function parseDatedValue(raw: string): DatedSpec | { error: DateParseError } {
  const trimmed = raw.trim();
  const mmdd = MM_DD.exec(trimmed);
  if (mmdd) {
    const month = Number(mmdd[1]);
    const day = Number(mmdd[2]);
    if (isImpossible(month, day)) return { error: "impossible" };
    return { month, day, year: null };
  }
  const full = YYYY_MM_DD.exec(trimmed);
  if (full) {
    const year = Number(full[1]);
    const month = Number(full[2]);
    const day = Number(full[3]);
    if (isImpossible(month, day)) return { error: "impossible" };
    if (month === 2 && day === 29 && !isLeapYear(year)) return { error: "impossible" };
    return { month, day, year };
  }
  return { error: "format" };
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/** Is `name` one of the reserved columns, case-insensitively (A8, FR-010)? */
export function isReservedColumn(name: string): boolean {
  const lower = name.toLowerCase();
  return (RESERVED_COLUMNS as readonly string[]).includes(lower);
}

/** The occurrence's target date in `year`: the spec's month/day, with 02-29 constrained to
 *  02-28 in a non-leap year (A24, FR-031). Throws for a year-specific spec and a different year. */
export function targetDateFor(spec: DatedSpec, year: number): Temporal.PlainDate {
  if (spec.year !== null && spec.year !== year) {
    throw new Error(`targetDateFor: spec is pinned to ${spec.year}, not ${year}`);
  }
  const day = spec.month === 2 && spec.day === 29 && !isLeapYear(year) ? 28 : spec.day;
  return Temporal.PlainDate.from({ year, month: spec.month, day });
}

/** The calendar dates (`YYYY-MM-DD`, leap-day collapsed) a row counts against for the per-date cap
 *  (FR-013, A11, research § 3): a year-specific row counts only against its own year; an every-year
 *  row counts against each of the next two years from `today`, so `03-14` and `2027-03-14` are seen
 *  to collide in 2027, and an every-year `02-29` collides with an every-year `02-28` in the three
 *  years out of four that collapse onto the same day. */
export function resolvedCapDates(spec: DatedSpec, today: Temporal.PlainDate): string[] {
  if (spec.year !== null) return [targetDateFor(spec, spec.year).toString()];
  return [targetDateFor(spec, today.year).toString(), targetDateFor(spec, today.year + 1).toString()];
}

/** The local date of the next occurrence not in `firedYears` whose target date is not behind
 *  `today`. `null` when the row has no occurrence left (a year-specific row already recorded, or
 *  one whose year is behind `today`). Forward-only and deterministic (B26). */
export function nextTargetDate(
  spec: DatedSpec,
  today: Temporal.PlainDate,
  firedYears: readonly number[],
): Temporal.PlainDate | null {
  if (spec.year !== null) {
    if (firedYears.includes(spec.year)) return null;
    if (spec.year < today.year) return null;
    const target = targetDateFor(spec, spec.year);
    if (target.year < today.year) return null;
    return target;
  }
  const fired = new Set(firedYears);
  let year = today.year;
  for (let guard = 0; guard < 10; guard += 1) {
    if (!fired.has(year)) {
      const target = targetDateFor(spec, year);
      if (Temporal.PlainDate.compare(target, today) >= 0) return target;
    }
    year += 1;
  }
  return null;
}

/** NORMATIVE eligibility (B4): `target - lead <= today <= target`, all local dates. */
export function isEligible(target: Temporal.PlainDate, leadDays: number, today: Temporal.PlainDate): boolean {
  const start = target.subtract({ days: leadDays });
  return Temporal.PlainDate.compare(today, start) >= 0 && Temporal.PlainDate.compare(today, target) <= 0;
}

/** Derived, for display only: local midnight of `target - lead` through `periodStartInstant`. */
export function dueInstant(target: Temporal.PlainDate, leadDays: number, zone: string): Date {
  return periodStartInstant(target.subtract({ days: leadDays }), zone);
}

/** Derived, for display only: local midnight of `target + 1 day`. */
export function windowEnd(target: Temporal.PlainDate, zone: string): Date {
  return periodStartInstant(target.add({ days: 1 }), zone);
}

/** The local date `now` falls on in `zone`. The one place an instant becomes a date. */
export function localToday(now: Date, zone: string): Temporal.PlainDate {
  return Temporal.Instant.fromEpochMilliseconds(now.getTime()).toZonedDateTimeISO(zone).toPlainDate();
}

/** The next `limit` occurrences across `rows`, soonest first, each with its generation instant
 *  (FR-044, FR-047). Rows with no next target date are omitted. */
export function upcoming(
  rows: readonly { id: string; keyValue: string; nextTargetDate: string | null }[],
  leadDays: number,
  zone: string,
  limit: number,
): { rowId: string; keyValue: string; target: string; dueAt: Date }[] {
  return rows
    .filter((row) => row.nextTargetDate !== null)
    .map((row) => {
      const target = Temporal.PlainDate.from(row.nextTargetDate!);
      return {
        rowId: row.id,
        keyValue: row.keyValue,
        target: row.nextTargetDate!,
        dueAt: dueInstant(target, leadDays, zone),
      };
    })
    .sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0))
    .slice(0, limit);
}
