import { Temporal } from "@js-temporal/polyfill";
import { describe, expect, test } from "vitest";
import { DEFAULT_USAGE_PERIOD, USAGE_PERIODS, usagePeriodWindow } from "./usage-period";

describe("usagePeriodWindow", () => {
  test("defaults and order", () => {
    expect(DEFAULT_USAGE_PERIOD).toBe("30d");
    expect(USAGE_PERIODS).toEqual(["30d", "month", "last-month", "all"]);
  });

  test("all has both bounds open, no zone lookup needed", () => {
    const window = usagePeriodWindow("all", "Pacific/Kiritimati", new Date("2026-06-15T12:00:00Z"));
    expect(window).toEqual({ from: null, to: null });
  });

  test("30d spans today and the 29 days before it", () => {
    const now = new Date("2026-06-15T18:00:00Z");
    const window = usagePeriodWindow("30d", "UTC", now);
    expect(window.from?.toISOString()).toBe("2026-05-17T00:00:00.000Z");
    expect(window.to?.toISOString()).toBe("2026-06-16T00:00:00.000Z");
  });

  test("month spans the 1st of this month through midnight after today", () => {
    const now = new Date("2026-06-15T18:00:00Z");
    const window = usagePeriodWindow("month", "UTC", now);
    expect(window.from?.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(window.to?.toISOString()).toBe("2026-06-16T00:00:00.000Z");
  });

  test("last-month spans the 1st of last month through the 1st of this month", () => {
    const now = new Date("2026-06-15T18:00:00Z");
    const window = usagePeriodWindow("last-month", "UTC", now);
    expect(window.from?.toISOString()).toBe("2026-05-01T00:00:00.000Z");
    expect(window.to?.toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });

  test("half-open [from, to): one call before `from` excluded, one at `from` included, one at `to` excluded", () => {
    const now = new Date("2026-06-15T18:00:00Z");
    const { from, to } = usagePeriodWindow("month", "UTC", now);
    const calledAt = (ms: number) => new Date(ms);
    const inWindow = (d: Date) => (from === null || d >= from) && (to === null || d < to);
    expect(inWindow(calledAt(from!.getTime() - 1))).toBe(false);
    expect(inWindow(calledAt(from!.getTime()))).toBe(true);
    expect(inWindow(calledAt(to!.getTime()))).toBe(false);
  });

  // The actual 2026 day each zone's clocks jump forward across local midnight, deleting it
  // (found by scanning the zone's own transitions, not asserted from memory — constitution I).
  const SPRING_FORWARD_AT_MIDNIGHT: Record<string, string> = {
    "America/Santiago": "2026-09-06",
    "America/Havana": "2026-03-08",
  };

  for (const timeZone of ["America/Santiago", "America/Havana"]) {
    test(`last-month crosses a DST transition inside the period in ${timeZone}, each boundary using its own offset (SC-013)`, () => {
      const transitionDay = Temporal.PlainDate.from(SPRING_FORWARD_AT_MIDNIGHT[timeZone]!);
      // `now` is in the month after the transition, so "last-month" is the transition's month.
      const now = new Date(
        transitionDay
          .with({ day: 15 })
          .add({ months: 1 })
          .toPlainDateTime()
          .toZonedDateTime(timeZone, { disambiguation: "compatible" }).epochMilliseconds,
      );

      const { from, to } = usagePeriodWindow("last-month", timeZone, now);
      expect(from).not.toBeNull();
      expect(to).not.toBeNull();
      expect(from!.getTime()).toBeLessThan(to!.getTime());

      // The two boundaries straddle the transition, so they resolve to different UTC offsets —
      // proof each is computed from its own local date, not one offset carried across the month.
      const offsetOf = (d: Date) => Temporal.Instant.fromEpochMilliseconds(d.getTime()).toZonedDateTimeISO(timeZone).offset;
      expect(offsetOf(from!)).not.toBe(offsetOf(to!));
    });

    test(`a deleted local midnight in ${timeZone} resolves forward under "compatible" disambiguation (SC-013)`, () => {
      const transitionDay = Temporal.PlainDate.from(SPRING_FORWARD_AT_MIDNIGHT[timeZone]!);
      // `now` is the day before the transition, so the "month" period's `to` bound (midnight after
      // today) is exactly the deleted midnight.
      const now = new Date(
        transitionDay.subtract({ days: 1 }).toPlainDateTime().toZonedDateTime(timeZone, { disambiguation: "compatible" })
          .epochMilliseconds,
      );

      const { to } = usagePeriodWindow("month", timeZone, now);
      expect(to).not.toBeNull();

      const toZoned = Temporal.Instant.fromEpochMilliseconds(to!.getTime()).toZonedDateTimeISO(timeZone);
      expect(toZoned.toPlainDate().toString()).toBe(transitionDay.toString());
      // The deleted 00:00 resolved forward to the first instant that exists that day, not before it.
      expect(toZoned.hour === 0 && toZoned.minute === 0).toBe(false);
    });
  }
});
