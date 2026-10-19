// lib/insights/trend: one account's metric readings -> a TrendSeries (data-model.md §7.1).
// Pure, total, no clock and no database.
import type { MetricShape } from "../../providers/types";
import { zonedDate } from "../compose/first-post";
import type { MetricReadingRow } from "../../server/dal/insights-read";

export interface TrendPoint {
  /** project-local ISO date, e.g. "2026-10-18" */
  day: string;
  value: number;
  capturedAt: Date;
}

export interface TrendSeries {
  accountId: string;
  accountName: string;
  providerKey: string;
  platform: string;
  metricKey: string;
  label: string;
  shape: MetricShape;
  /** ascending; a day with no reading is simply absent (FR-014) */
  points: TrendPoint[];
  range: { from: string; to: string };
  /** the newest point's capturedAt (FR-016) */
  asOf: Date | null;
  /** US1.5: what to say when polling has been failing */
  lastSuccessfulReadAt: Date | null;
}

export interface BuildTrendSeriesInput {
  accountId: string;
  accountName: string;
  providerKey: string;
  platform: string;
  metricKey: string;
  label: string;
  shape: MetricShape;
  /** this account's readings for this metric key only, any order */
  rows: readonly MetricReadingRow[];
  timeZone: string;
  range: { from: Date; to: Date };
  lastSuccessfulReadAt: Date | null;
}

/**
 * Null for an `unknown` shape (US1.6, FR-004) — absent entirely, never a zero or empty series.
 * Otherwise buckets `rows` by project-local day and keeps the newest reading per day (FR-013), so a
 * `windowed` metric read several times a day collapses to one value and a `cumulative` metric's
 * rises and falls are preserved. A day with no reading is simply absent (FR-014, US1.5).
 */
export function buildTrendSeries(input: BuildTrendSeriesInput): TrendSeries | null {
  if (input.shape.kind === "unknown") return null;

  const latestPerDay = new Map<string, MetricReadingRow>();
  for (const row of input.rows) {
    const day = zonedDate(row.capturedAt, input.timeZone);
    const existing = latestPerDay.get(day);
    if (!existing || row.capturedAt >= existing.capturedAt) latestPerDay.set(day, row);
  }
  const points: TrendPoint[] = [...latestPerDay.entries()]
    .map(([day, row]) => ({ day, value: row.value, capturedAt: row.capturedAt }))
    .sort((a, b) => a.day.localeCompare(b.day));

  return {
    accountId: input.accountId,
    accountName: input.accountName,
    providerKey: input.providerKey,
    platform: input.platform,
    metricKey: input.metricKey,
    label: input.label,
    shape: input.shape,
    points,
    range: { from: zonedDate(input.range.from, input.timeZone), to: zonedDate(input.range.to, input.timeZone) },
    asOf: points.length > 0 ? points[points.length - 1]!.capturedAt : null,
    lastSuccessfulReadAt: input.lastSuccessfulReadAt,
  };
}
