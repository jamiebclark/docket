import { describe, expect, it } from "vitest";
import { pinterestAnalyticsWindow } from "./window";

describe("pinterestAnalyticsWindow", () => {
  it("end is the UTC calendar date of now; start is the UTC calendar date of publishedAt when within 90 days (FR-030)", () => {
    const now = new Date("2026-03-15T23:59:59Z");
    const publishedAt = new Date("2026-02-01T05:00:00Z");
    expect(pinterestAnalyticsWindow({ publishedAt, now })).toEqual({ start: "2026-02-01", end: "2026-03-15" });
  });

  it("a post published two years ago still clamps start to end − 90 days, never wider (contracts/platform-readers-082.md §2)", () => {
    const now = new Date("2026-03-15T00:00:00Z");
    const publishedAt = new Date("2024-01-01T00:00:00Z");
    expect(pinterestAnalyticsWindow({ publishedAt, now })).toEqual({ start: "2025-12-15", end: "2026-03-15" });
  });

  it("end is never in the future: it is always today's UTC date, whatever time of day now is", () => {
    const now = new Date("2026-03-15T00:00:01Z");
    const publishedAt = new Date("2026-03-15T00:00:00Z");
    expect(pinterestAnalyticsWindow({ publishedAt, now }).end).toBe("2026-03-15");
  });

  it("start never exceeds end, even for a post published this same UTC day", () => {
    const now = new Date("2026-03-15T08:00:00Z");
    const publishedAt = new Date("2026-03-15T23:00:00Z");
    const w = pinterestAnalyticsWindow({ publishedAt, now });
    expect(w.start <= w.end).toBe(true);
  });

  it("reads no clock itself: identical `now` arguments always produce identical results", () => {
    const now = new Date("2026-03-15T12:00:00Z");
    const publishedAt = new Date("2026-01-01T00:00:00Z");
    const a = pinterestAnalyticsWindow({ publishedAt, now });
    const b = pinterestAnalyticsWindow({ publishedAt, now });
    expect(a).toEqual(b);
  });
});
