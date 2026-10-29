import { describe, expect, it } from "vitest";
import { dayHeading, dayKeyInZone, formatLocalDate, formatMonthDay } from "./format";

describe("formatLocalDate", () => {
  it("renders a calendar date with the year", () => {
    expect(formatLocalDate("2027-03-14")).toBe("Mar 14, 2027");
  });
});

describe("formatMonthDay", () => {
  it("renders a month and day with no year, from MM-DD", () => {
    expect(formatMonthDay("03-14")).toBe("Mar 14");
  });

  it("renders a month and day with no year, from YYYY-MM-DD", () => {
    expect(formatMonthDay("2027-03-14")).toBe("Mar 14");
  });
});

describe("dayKeyInZone", () => {
  // 03:30 UTC on the 20th is still the 19th in New York. A reader in that project should see the
  // comment filed under the day they lived through, not the day UTC was having.
  const lateNight = new Date("2026-10-20T03:30:00Z");

  it("buckets by the project's day, not UTC's", () => {
    expect(dayKeyInZone(lateNight, "America/New_York")).toBe("2026-10-19");
    expect(dayKeyInZone(lateNight, "UTC")).toBe("2026-10-20");
  });

  it("buckets an instant east of UTC into the following day where that is local", () => {
    expect(dayKeyInZone(new Date("2026-10-19T22:30:00Z"), "Asia/Tokyo")).toBe("2026-10-20");
  });
});

describe("dayHeading", () => {
  const now = new Date("2026-10-20T15:00:00Z"); // mid-afternoon in New York, so no edge
  const tz = "America/New_York";

  it("names today and yesterday", () => {
    expect(dayHeading("2026-10-20", tz, now)).toBe("Today");
    expect(dayHeading("2026-10-19", tz, now)).toBe("Yesterday");
  });

  it("falls back to a weekday and date further back", () => {
    expect(dayHeading("2026-10-16", tz, now)).toBe("Fri, Oct 16");
  });

  it("reads the key as the day it says, without shifting it by the zone", () => {
    // The key is already local. Read as local time it would slide a day backwards in New York.
    expect(dayHeading("2026-10-01", tz, now)).toBe("Thu, Oct 1");
  });

  it("calls it Today across a zone boundary, where UTC would already say tomorrow", () => {
    const lateNight = new Date("2026-10-20T03:30:00Z"); // still the 19th in New York
    expect(dayHeading("2026-10-19", tz, lateNight)).toBe("Today");
  });
});
