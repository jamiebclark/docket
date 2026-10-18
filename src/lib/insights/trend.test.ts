import { describe, expect, it } from "vitest";
import type { MetricReadingRow } from "../../server/dal/insights-read";
import { buildTrendSeries } from "./trend";

const BASE = {
  accountId: "acct-1",
  accountName: "Bluesky account",
  providerKey: "bluesky",
  platform: "Bluesky",
  metricKey: "followersCount",
  label: "Followers",
  timeZone: "America/New_York",
  range: { from: new Date("2026-09-01T00:00:00Z"), to: new Date("2026-10-01T00:00:00Z") },
  lastSuccessfulReadAt: null,
} as const;

function reading(day: string, hour: string, value: number): MetricReadingRow {
  return { subjectId: "acct-1", metricKey: "followersCount", value, capturedAt: new Date(`${day}T${hour}:00:00Z`) };
}

describe("buildTrendSeries", () => {
  it("rises and falls for a cumulative series (US1.1)", () => {
    const rows = [reading("2026-09-10", "12", 100), reading("2026-09-11", "12", 90), reading("2026-09-12", "12", 110)];
    const series = buildTrendSeries({ ...BASE, shape: { kind: "cumulative" }, rows });
    expect(series?.points.map((p) => p.value)).toEqual([100, 90, 110]);
  });

  it("collapses a windowed metric to at most one value per project-local day (US1.2, FR-013)", () => {
    const rows = [
      reading("2026-09-10", "13", 10), // read 4x the same project-local (New York) day
      reading("2026-09-10", "15", 20),
      reading("2026-09-10", "17", 30),
      reading("2026-09-10", "19", 40),
    ];
    const series = buildTrendSeries({ ...BASE, metricKey: "reach", label: "Reach", shape: { kind: "windowed", windowMs: 86_400_000 }, rows });
    expect(series?.points).toHaveLength(1);
    expect(series?.points[0]!.value).toBe(40); // newest reading wins
  });

  it("leaves a gap where no snapshot exists, never interpolated or zeroed (US1.5, FR-014)", () => {
    const rows = [reading("2026-09-10", "12", 5), reading("2026-09-15", "12", 7)];
    const series = buildTrendSeries({ ...BASE, shape: { kind: "cumulative" }, rows });
    expect(series?.points.map((p) => p.day)).toEqual(["2026-09-10", "2026-09-15"]);
  });

  it("is absent entirely for an unknown-shaped key (US1.6, FR-004)", () => {
    const rows = [reading("2026-09-10", "12", 5)];
    const series = buildTrendSeries({ ...BASE, metricKey: "page_follows", shape: { kind: "unknown", reason: "no longer declared" }, rows });
    expect(series).toBeNull();
  });

  it("reports asOf as the newest point's capturedAt (FR-016)", () => {
    const rows = [reading("2026-09-10", "12", 5), reading("2026-09-15", "08", 7)];
    const series = buildTrendSeries({ ...BASE, shape: { kind: "cumulative" }, rows });
    expect(series?.asOf?.toISOString()).toBe(new Date("2026-09-15T08:00:00Z").toISOString());
  });

  it("carries lastSuccessfulReadAt through untouched (US1.5)", () => {
    const lastSuccessfulReadAt = new Date("2026-09-20T00:00:00Z");
    const series = buildTrendSeries({ ...BASE, shape: { kind: "cumulative" }, rows: [], lastSuccessfulReadAt });
    expect(series?.lastSuccessfulReadAt).toBe(lastSuccessfulReadAt);
    expect(series?.points).toEqual([]);
    expect(series?.asOf).toBeNull();
  });
});
