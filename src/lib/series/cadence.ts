// Pure, the whole of a standing series' clock: no database, no `Date.now()`.

import { Temporal } from "@js-temporal/polyfill";

export const CADENCE_PERIODS = ["day", "week", "month"] as const;
export type CadencePeriod = (typeof CADENCE_PERIODS)[number];

export const CADENCE_COUNT_MIN = 1;
export const CADENCE_COUNT_MAX = 10;

function toZoned(instant: Date, zone: string): Temporal.ZonedDateTime {
  return Temporal.Instant.fromEpochMilliseconds(instant.getTime()).toZonedDateTimeISO(zone);
}

function boundaryDate(date: Temporal.PlainDate, period: CadencePeriod): Temporal.PlainDate {
  if (period === "day") return date;
  if (period === "week") return date.subtract({ days: date.dayOfWeek - 1 });
  return date.with({ day: 1 });
}

/** The local date on which `instant`'s period starts, in `zone`. */
export function periodStartDate(instant: Date, zone: string, period: CadencePeriod): Temporal.PlainDate {
  return boundaryDate(toZoned(instant, zone).toPlainDate(), period);
}

/** The instant that local date's period begins at. A midnight that does not exist moves forward;
 *  one that exists twice takes the earlier offset. Exactly one instant, always. */
export function periodStartInstant(date: Temporal.PlainDate, zone: string): Date {
  const zdt = date
    .toPlainDateTime(Temporal.PlainTime.from({ hour: 0 }))
    .toZonedDateTime(zone, { disambiguation: "compatible" });
  return new Date(zdt.epochMilliseconds);
}

function nextBoundaryDate(date: Temporal.PlainDate, period: CadencePeriod): Temporal.PlainDate {
  if (period === "day") return date.add({ days: 1 });
  if (period === "week") return date.add({ weeks: 1 });
  return date.add({ months: 1 });
}

/** The first period start strictly after `instant`. Used at create and at resume (FR-010, FR-055). */
export function nextBoundaryAfter(instant: Date, zone: string, period: CadencePeriod): Date {
  const current = periodStartDate(instant, zone, period);
  let candidateDate = current;
  let candidateInstant = periodStartInstant(candidateDate, zone);
  while (candidateInstant.getTime() <= instant.getTime()) {
    candidateDate = nextBoundaryDate(candidateDate, period);
    candidateInstant = periodStartInstant(candidateDate, zone);
  }
  return candidateInstant;
}

/** How many boundaries fall in `(from, to]`. `0` when `from >= to`. FR-013's "missed periods". */
export function boundariesBetween(from: Date, to: Date, zone: string, period: CadencePeriod): number {
  if (from.getTime() >= to.getTime()) return 0;
  let count = 0;
  let cursor = nextBoundaryAfter(from, zone, period);
  while (cursor.getTime() <= to.getTime()) {
    count += 1;
    cursor = nextBoundaryAfter(cursor, zone, period);
  }
  return count;
}
