import { describe, expect, it } from "vitest";
import { firstPostCalendarHref, zonedDate } from "./first-post";

describe("zonedDate", () => {
  it("uses the zone's date across the date line", () => {
    expect(zonedDate("2026-03-10T23:30:00Z", "UTC")).toBe("2026-03-10");
    expect(zonedDate("2026-03-10T23:30:00Z", "Pacific/Auckland")).toBe("2026-03-11");
    expect(zonedDate(new Date("2026-03-10T03:00:00Z"), "America/Los_Angeles")).toBe("2026-03-09");
  });
});

describe("firstPostCalendarHref", () => {
  const base = { slug: "acme", timeZone: "Pacific/Auckland" };
  it("links to the date of the earliest ok row in the project zone", () => {
    const rows = [
      { ok: true, scheduledAt: "2026-03-12T10:00:00Z" },
      { ok: true, scheduledAt: "2026-03-10T23:30:00Z" },
      { ok: false, scheduledAt: "2026-03-01T00:00:00Z" },
    ];
    expect(firstPostCalendarHref({ ...base, kind: "schedule", rows })).toBe("/p/acme/calendar?view=month&date=2026-03-11");
    expect(firstPostCalendarHref({ ...base, kind: "queue", rows })).toBe("/p/acme/calendar?view=month&date=2026-03-11");
  });
  it("gives the bare calendar for now", () => {
    expect(firstPostCalendarHref({ ...base, kind: "now", rows: [{ ok: true }] })).toBe("/p/acme/calendar");
  });
  it("gives no dated link when every row failed", () => {
    expect(firstPostCalendarHref({ ...base, kind: "schedule", rows: [{ ok: false, scheduledAt: "2026-03-10T00:00:00Z" }] })).toBe("/p/acme/calendar");
  });
});
