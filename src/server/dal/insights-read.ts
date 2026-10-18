// dal/insights-read: folded points and surviving snapshots, read together (contracts/fold.md §4).
import { sql } from "drizzle-orm";
import { getDb } from "../db/client";

/** One raw reading, before project-local-day bucketing (which `src/lib/insights/trend.ts` does). */
export interface MetricReadingRow {
  subjectId: string;
  metricKey: string;
  value: number;
  capturedAt: Date;
}

/**
 * Account-metric readings over `[from, to)`, UNION ALL of surviving snapshots (exploded via
 * `jsonb_each`, numeric values only) and folded rollup points, both pinned on `project_id` (what
 * `tests/helpers/scope-check` requires). Ascending by `capturedAt` so the caller can keep the last
 * reading per (subject, metric key, day) with a single pass.
 */
export async function accountMetricReadingRows(
  projectId: string,
  socialAccountIds: readonly string[],
  from: Date,
  to: Date,
): Promise<MetricReadingRow[]> {
  if (socialAccountIds.length === 0) return [];
  const ids = sql.param([...socialAccountIds]);
  const rows = await getDb().execute<{ subject_id: string; metric_key: string; value: number; captured_at: Date }>(sql`
    SELECT subject_id, metric_key, value, captured_at FROM (
      SELECT account_metric_snapshots.social_account_id AS subject_id, m.key AS metric_key, (m.value #>> '{}')::double precision AS value, account_metric_snapshots.captured_at
        FROM account_metric_snapshots
        CROSS JOIN LATERAL jsonb_each(account_metric_snapshots.metrics) AS m(key, value)
       WHERE account_metric_snapshots.project_id = ${projectId} AND account_metric_snapshots.social_account_id = ANY(${ids})
         AND account_metric_snapshots.captured_at >= ${from} AND account_metric_snapshots.captured_at < ${to}
         AND jsonb_typeof(m.value) = 'number'
      UNION ALL
      SELECT account_metric_rollups.social_account_id AS subject_id, account_metric_rollups.metric_key, account_metric_rollups.value, account_metric_rollups.captured_at
        FROM account_metric_rollups
       WHERE account_metric_rollups.project_id = ${projectId} AND account_metric_rollups.social_account_id = ANY(${ids})
         AND account_metric_rollups.captured_at >= ${from} AND account_metric_rollups.captured_at < ${to}
    ) rows
    ORDER BY captured_at ASC
  `);
  return rows.rows.map((r) => ({ subjectId: r.subject_id, metricKey: r.metric_key, value: Number(r.value), capturedAt: new Date(r.captured_at) }));
}

/** Same as `accountMetricReadingRows`, for post targets. */
export async function postMetricReadingRows(
  projectId: string,
  postTargetIds: readonly string[],
  from: Date,
  to: Date,
): Promise<MetricReadingRow[]> {
  if (postTargetIds.length === 0) return [];
  const ids = sql.param([...postTargetIds]);
  const rows = await getDb().execute<{ subject_id: string; metric_key: string; value: number; captured_at: Date }>(sql`
    SELECT subject_id, metric_key, value, captured_at FROM (
      SELECT post_metric_snapshots.post_target_id AS subject_id, m.key AS metric_key, (m.value #>> '{}')::double precision AS value, post_metric_snapshots.captured_at
        FROM post_metric_snapshots
        CROSS JOIN LATERAL jsonb_each(post_metric_snapshots.metrics) AS m(key, value)
       WHERE post_metric_snapshots.project_id = ${projectId} AND post_metric_snapshots.post_target_id = ANY(${ids})
         AND post_metric_snapshots.captured_at >= ${from} AND post_metric_snapshots.captured_at < ${to}
         AND jsonb_typeof(m.value) = 'number'
      UNION ALL
      SELECT post_metric_rollups.post_target_id AS subject_id, post_metric_rollups.metric_key, post_metric_rollups.value, post_metric_rollups.captured_at
        FROM post_metric_rollups
       WHERE post_metric_rollups.project_id = ${projectId} AND post_metric_rollups.post_target_id = ANY(${ids})
         AND post_metric_rollups.captured_at >= ${from} AND post_metric_rollups.captured_at < ${to}
    ) rows
    ORDER BY captured_at ASC
  `);
  return rows.rows.map((r) => ({ subjectId: r.subject_id, metricKey: r.metric_key, value: Number(r.value), capturedAt: new Date(r.captured_at) }));
}

/**
 * The account-trends read (US1): the same project-pinned `UNION ALL` of surviving snapshots and
 * folded rollup points as `accountMetricReadingRows`, named for its caller,
 * `src/server/services/insights/view.ts` (research.md §6).
 */
export const accountTrendRows = accountMetricReadingRows;

/**
 * Buckets ascending `rows` by UTC day and keeps the last (newest `capturedAt`) reading per (subject,
 * metric key, day) — exactly one value per day, a point beating nothing and a surviving snapshot
 * beating an older point (contracts/fold.md §4, FR-054).
 */
export function latestPerSubjectMetricDay(rows: readonly MetricReadingRow[]): MetricReadingRow[] {
  const latest = new Map<string, MetricReadingRow>();
  for (const row of rows) {
    const day = row.capturedAt.toISOString().slice(0, 10);
    const key = `${row.subjectId} ${row.metricKey} ${day}`;
    const existing = latest.get(key);
    if (!existing || row.capturedAt >= existing.capturedAt) latest.set(key, row);
  }
  return [...latest.values()];
}
