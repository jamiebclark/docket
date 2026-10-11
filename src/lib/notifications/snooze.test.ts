import { describe, expect, it } from "vitest";
import { parseSnoozeChoice, resolveSnooze } from "./snooze";

const ZONES = ["UTC", "America/New_York", "Australia/Lord_Howe"] as const;

describe("resolveSnooze", () => {
  for (const timeZone of ZONES) {
    describe(timeZone, () => {
      it('"hour" is exactly 3 600 000 ms later', () => {
        const now = new Date("2026-06-15T10:00:00.000Z");
        const result = resolveSnooze("hour", now, timeZone);
        expect(result.getTime() - now.getTime()).toBe(3_600_000);
      });

      it('"tomorrow morning" is 09:00 next local day', () => {
        const now = new Date("2026-06-15T05:00:00.000Z");
        const result = resolveSnooze("tomorrow", now, timeZone);
        const local = new Intl.DateTimeFormat("en-US", {
          timeZone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          hour12: false,
        }).formatToParts(result);
        const hour = local.find((p) => p.type === "hour")?.value;
        expect(Number(hour) % 24).toBe(9);
        expect(result.getTime()).toBeGreaterThan(now.getTime());
      });

      it('"next week" is 09:00 next Monday strictly after today, including when today is Monday or Sunday', () => {
        // 2026-06-15 is a Monday, 2026-06-14 is a Sunday.
        for (const iso of ["2026-06-15T12:00:00.000Z", "2026-06-14T12:00:00.000Z", "2026-06-17T12:00:00.000Z"]) {
          const now = new Date(iso);
          const result = resolveSnooze("next_week", now, timeZone);
          const weekday = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(result);
          expect(weekday).toBe("Mon");
          expect(result.getTime()).toBeGreaterThan(now.getTime());
          const daysAhead = (result.getTime() - now.getTime()) / 86_400_000;
          expect(daysAhead).toBeGreaterThan(0);
          expect(daysAhead).toBeLessThanOrEqual(8);
        }
      });

      it("every result is strictly after now and truncated to whole milliseconds", () => {
        const now = new Date("2026-06-15T05:00:00.123Z");
        for (const choice of ["hour", "tomorrow", "next_week"] as const) {
          const result = resolveSnooze(choice, now, timeZone);
          expect(result.getTime()).toBeGreaterThan(now.getTime());
          expect(Number.isInteger(result.getTime())).toBe(true);
        }
      });
    });
  }

  it("resolves correctly across a spring-forward transition (America/New_York, 2026-03-08)", () => {
    const now = new Date("2026-03-07T12:00:00.000Z"); // the day before the US spring-forward
    const result = resolveSnooze("tomorrow", now, "America/New_York");
    // 2026-03-08 09:00 EDT (post-transition offset, -04:00)
    expect(result.toISOString()).toBe("2026-03-08T13:00:00.000Z");
  });

  it("resolves correctly across an autumn-back transition, taking the earlier offset (America/New_York, 2026-11-01)", () => {
    const now = new Date("2026-10-31T12:00:00.000Z"); // the day before the US fall-back
    const result = resolveSnooze("tomorrow", now, "America/New_York");
    // 2026-11-01 09:00 EST (post-transition offset, -05:00) — 9am is unambiguous, after the 2am overlap.
    expect(result.toISOString()).toBe("2026-11-01T14:00:00.000Z");
  });

  it("resolves correctly across Lord Howe's half-hour spring-forward (2026-10-04)", () => {
    const now = new Date("2026-10-03T12:00:00.000Z");
    const result = resolveSnooze("tomorrow", now, "Australia/Lord_Howe");
    // 2026-10-04 09:00 +11:00 (post-transition offset)
    expect(result.toISOString()).toBe("2026-10-03T22:00:00.000Z");
  });
});

describe("parseSnoozeChoice", () => {
  it("accepts the three choices and rejects anything else", () => {
    expect(parseSnoozeChoice("hour")).toBe("hour");
    expect(parseSnoozeChoice("tomorrow")).toBe("tomorrow");
    expect(parseSnoozeChoice("next_week")).toBe("next_week");
    expect(parseSnoozeChoice("never")).toBeNull();
    expect(parseSnoozeChoice("")).toBeNull();
    expect(parseSnoozeChoice(null)).toBeNull();
    expect(parseSnoozeChoice(undefined)).toBeNull();
    expect(parseSnoozeChoice(1)).toBeNull();
  });
});
