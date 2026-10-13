import { Temporal } from "@js-temporal/polyfill";

export type UsagePeriod = "30d" | "month" | "last-month" | "all";

/** Order shown on screen. */
export const USAGE_PERIODS: readonly UsagePeriod[] = ["30d", "month", "last-month", "all"];

export const DEFAULT_USAGE_PERIOD: UsagePeriod = "30d";

/** Half-open [from, to); a null bound is open, so "all time" is { from: null, to: null }. */
export interface UsageWindow {
  from: Date | null;
  to: Date | null;
}

function toInstant(date: Temporal.PlainDate, timeZone: string): Date {
  const zoned = date.toPlainDateTime().toZonedDateTime(timeZone, { disambiguation: "compatible" });
  return new Date(zoned.epochMilliseconds);
}

/** The half-open instant window `[from, to)` for `period`, in the project's zone. */
export function usagePeriodWindow(period: UsagePeriod, timeZone: string, now: Date): UsageWindow {
  if (period === "all") return { from: null, to: null };

  const today = Temporal.Instant.fromEpochMilliseconds(now.getTime()).toZonedDateTimeISO(timeZone).toPlainDate();
  const tomorrow = today.add({ days: 1 });

  if (period === "30d") {
    return { from: toInstant(today.subtract({ days: 29 }), timeZone), to: toInstant(tomorrow, timeZone) };
  }

  const firstOfThisMonth = today.with({ day: 1 });
  if (period === "month") {
    return { from: toInstant(firstOfThisMonth, timeZone), to: toInstant(tomorrow, timeZone) };
  }

  // last-month
  const firstOfLastMonth = firstOfThisMonth.subtract({ months: 1 });
  return { from: toInstant(firstOfLastMonth, timeZone), to: toInstant(firstOfThisMonth, timeZone) };
}
