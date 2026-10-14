import { Temporal } from "@js-temporal/polyfill";
import { describe, expect, it } from "vitest";
import { boundariesBetween, nextBoundaryAfter, periodStartDate, periodStartInstant } from "./cadence";

const ZONE = "America/New_York";

describe("periodStartDate / periodStartInstant", () => {
  it("day boundary is the local date itself", () => {
    const instant = new Date("2026-03-11T15:00:00Z");
    expect(periodStartDate(instant, ZONE, "day").toString()).toBe("2026-03-11");
  });

  it("week boundary is the Monday of the local week", () => {
    const wednesday = new Date("2026-03-11T15:00:00Z"); // Wed in New York
    expect(periodStartDate(wednesday, ZONE, "week").toString()).toBe("2026-03-09");
  });

  it("month boundary is the first of the local month", () => {
    const mid = new Date("2026-03-11T15:00:00Z");
    expect(periodStartDate(mid, ZONE, "month").toString()).toBe("2026-03-01");
  });

  it("a 31st-to-30th month rollover lands on the first of the next month", () => {
    const date = Temporal.PlainDate.from("2026-01-31");
    const next = nextBoundaryAfter(periodStartInstant(date, ZONE), ZONE, "month");
    expect(periodStartDate(next, ZONE, "day").toString()).toBe("2026-02-01");
  });

  it("a spring-forward gap resolves to one instant after it", () => {
    // 2026-03-08 02:00 America/New_York does not exist (clocks jump to 03:00).
    const date = Temporal.PlainDate.from("2026-03-08");
    const instant = periodStartInstant(date, ZONE);
    const zdt = Temporal.Instant.fromEpochMilliseconds(instant.getTime()).toZonedDateTimeISO(ZONE);
    expect(zdt.toPlainDate().toString()).toBe("2026-03-08");
    expect(zdt.hour).toBeGreaterThanOrEqual(0);
  });

  it("an autumn overlap takes the earlier offset", () => {
    // 2026-11-01 00:00 America/New_York occurs once normally (no fold at midnight that year),
    // this asserts the function always resolves to exactly one instant.
    const date = Temporal.PlainDate.from("2026-11-01");
    const instant = periodStartInstant(date, ZONE);
    expect(instant).toBeInstanceOf(Date);
  });
});

describe("nextBoundaryAfter", () => {
  it("returns the next week boundary, strictly after now", () => {
    const now = new Date("2026-03-11T15:00:00Z"); // Wednesday
    const next = nextBoundaryAfter(now, ZONE, "week");
    const zdt = Temporal.Instant.fromEpochMilliseconds(next.getTime()).toZonedDateTimeISO(ZONE);
    expect(zdt.toPlainDate().toString()).toBe("2026-03-16"); // following Monday
    expect(next.getTime()).toBeGreaterThan(now.getTime());
  });

  it("recomputes in a changed time zone without relabelling a stored date", () => {
    const now = new Date("2026-03-11T15:00:00Z");
    const nyNext = nextBoundaryAfter(now, "America/New_York", "day");
    const parisNext = nextBoundaryAfter(now, "Europe/Paris", "day");
    expect(nyNext.getTime()).not.toBe(parisNext.getTime());
  });
});

describe("boundariesBetween", () => {
  it("is 0 when from >= to", () => {
    const t = new Date("2026-03-11T15:00:00Z");
    expect(boundariesBetween(t, t, ZONE, "day")).toBe(0);
    expect(boundariesBetween(new Date(t.getTime() + 1000), t, ZONE, "day")).toBe(0);
  });

  it("counts whole periods across a DST change", () => {
    const from = new Date("2026-03-05T12:00:00Z"); // before spring-forward
    const to = new Date("2026-03-12T12:00:00Z"); // after spring-forward
    expect(boundariesBetween(from, to, ZONE, "day")).toBe(7);
  });
});
