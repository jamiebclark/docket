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

/** A named, removable fact as read from the database — id plus its recorded and (if still live) current name. */
export interface DbNamedFact {
  id: string;
  recordedName: string;
  liveName: string | null;
}

/**
 * One row per comparable published target, carrying every dimension key `src/lib/insights/compare.ts`
 * needs (research.md §6). `metricKey`/`value`/`capturedAt` are null when the target has no reading for
 * any metric at all — the target still appears, so `no_snapshot`/`frozen_without_reading` are counted
 * rather than the target silently disappearing. A target with readings for several metric keys
 * appears once per key (`src/server/services/insights/view.ts` groups by `targetId` to reassemble it).
 */
export interface ComparableTargetRow {
  targetId: string;
  postId: string;
  accountId: string;
  accountName: string;
  providerKey: string;
  scheduleKind: "slot" | "explicit" | "now";
  slotOccurrenceAt: Date | null;
  /** Whether the target's posting slot still exists — the slot's own weekday+time is re-derived from `slotOccurrenceAt` (research.md §2.1). */
  slotId: string | null;
  publishedAt: Date;
  origin: "manual" | "generated" | "api";
  voiceProfile: DbNamedFact | null;
  seriesKind: ({ occurrenceRule: "cadence" | "dated_list" } & DbNamedFact) | null;
  externalId: string | null;
  frozenWithoutReading: boolean;
  metricKey: string | null;
  value: number | null;
  capturedAt: Date | null;
}

interface ComparableTargetDbRow extends Record<string, unknown> {
  target_id: string;
  post_id: string;
  account_id: string;
  account_name: string;
  provider_key: string;
  schedule_kind: "slot" | "explicit" | "now";
  slot_occurrence_at: Date | null;
  slot_id: string | null;
  published_at: Date;
  origin: "manual" | "generated" | "api";
  external_id: string | null;
  frozen_without_reading: boolean;
  vp_id: string | null;
  vp_recorded_name: string | null;
  vp_live_name: string | null;
  series_id: string | null;
  series_occurrence_rule: "cadence" | "dated_list" | null;
  series_recorded_name: string | null;
  series_live_name: string | null;
  metric_key: string | null;
  value: string | null;
  captured_at: Date | null;
}

/**
 * US3/US4 (research.md §6): one query — a `targets` CTE carrying every dimension key for published
 * targets in `[from, to)`, left-joined against a `values` CTE that is a `DISTINCT ON` over snapshots
 * `UNION ALL` rollups, the latest reading per (target, metric key). The generation record's recorded
 * `voiceProfile`/`standingSeries` are preferred (contracts/comparisons.md §2); the live
 * position→run→series join is the fallback for the series kind while it still resolves (research.md
 * §2.2).
 */
export async function comparableTargetRows(projectId: string, from: Date, to: Date): Promise<ComparableTargetRow[]> {
  const rows = await getDb().execute<ComparableTargetDbRow>(sql`
    WITH targets AS (
      SELECT
        pt.id AS target_id, pt.post_id, pt.social_account_id AS account_id, sa.display_name AS account_name,
        sa.provider_key, pt.schedule_kind, pt.slot_occurrence_at, pt.slot_id, pt.published_at,
        p.origin, pt.external_id,
        (pmps.frozen_reason IN ('gone', 'expired', 'unqueryable') AND pmps.last_captured_at IS NULL) AS frozen_without_reading,
        (p.generation_metadata -> 'records' -> -1 -> 'voiceProfile' ->> 'id') AS vp_id,
        (p.generation_metadata -> 'records' -> -1 -> 'voiceProfile' ->> 'name') AS vp_recorded_name,
        vprof.name AS vp_live_name,
        COALESCE(
          (p.generation_metadata -> 'records' -> -1 -> 'standingSeries' ->> 'id'),
          live_ss.id::text
        ) AS series_id,
        COALESCE(
          (p.generation_metadata -> 'records' -> -1 -> 'standingSeries' ->> 'occurrenceRule'),
          live_ss.occurrence_rule::text
        ) AS series_occurrence_rule,
        COALESCE(
          (p.generation_metadata -> 'records' -> -1 -> 'standingSeries' ->> 'name'),
          live_ss.name
        ) AS series_recorded_name,
        COALESCE(rec_ss.name, live_ss.name) AS series_live_name
      FROM post_targets pt
      JOIN posts p ON p.id = pt.post_id AND p.project_id = pt.project_id
      JOIN social_accounts sa ON sa.id = pt.social_account_id AND sa.project_id = pt.project_id
      LEFT JOIN post_metric_poll_states pmps ON pmps.post_target_id = pt.id AND pmps.project_id = pt.project_id
      LEFT JOIN voice_profiles vprof
        ON vprof.id = (p.generation_metadata -> 'records' -> -1 -> 'voiceProfile' ->> 'id')::uuid
       AND vprof.project_id = pt.project_id
       AND vprof.archived_at IS NULL
      LEFT JOIN standing_series rec_ss
        ON rec_ss.id = (p.generation_metadata -> 'records' -> -1 -> 'standingSeries' ->> 'id')::uuid
       AND rec_ss.project_id = pt.project_id
      LEFT JOIN standing_series_positions ssp ON ssp.id = p.standing_series_position_id AND ssp.project_id = pt.project_id
      LEFT JOIN standing_series_runs ssr ON ssr.id = ssp.run_id AND ssr.project_id = pt.project_id
      LEFT JOIN standing_series live_ss ON live_ss.id = ssr.series_id AND live_ss.project_id = pt.project_id
     WHERE pt.project_id = ${projectId} AND pt.status = 'published'
       AND pt.published_at >= ${from} AND pt.published_at < ${to}
    ),
    readings AS (
      SELECT DISTINCT ON (subject_id, metric_key) subject_id, metric_key, value, captured_at FROM (
        SELECT post_metric_snapshots.post_target_id AS subject_id, m.key AS metric_key,
               (m.value #>> '{}')::double precision AS value, post_metric_snapshots.captured_at
          FROM post_metric_snapshots
          CROSS JOIN LATERAL jsonb_each(post_metric_snapshots.metrics) AS m(key, value)
         WHERE post_metric_snapshots.project_id = ${projectId}
           AND post_metric_snapshots.post_target_id IN (SELECT target_id FROM targets)
           AND jsonb_typeof(m.value) = 'number'
        UNION ALL
        SELECT post_metric_rollups.post_target_id AS subject_id, post_metric_rollups.metric_key,
               post_metric_rollups.value, post_metric_rollups.captured_at
          FROM post_metric_rollups
         WHERE post_metric_rollups.project_id = ${projectId}
           AND post_metric_rollups.post_target_id IN (SELECT target_id FROM targets)
      ) u
      ORDER BY subject_id, metric_key, captured_at DESC
    )
    SELECT
      targets.target_id, targets.post_id, targets.account_id, targets.account_name, targets.provider_key,
      targets.schedule_kind, targets.slot_occurrence_at, targets.slot_id, targets.published_at,
      targets.origin, targets.external_id, targets.frozen_without_reading,
      targets.vp_id, targets.vp_recorded_name, targets.vp_live_name,
      targets.series_id, targets.series_occurrence_rule, targets.series_recorded_name, targets.series_live_name,
      readings.metric_key, readings.value, readings.captured_at
    FROM targets
    LEFT JOIN readings ON readings.subject_id = targets.target_id
  `);

  return rows.rows.map((r) => ({
    targetId: r.target_id,
    postId: r.post_id,
    accountId: r.account_id,
    accountName: r.account_name,
    providerKey: r.provider_key,
    scheduleKind: r.schedule_kind,
    slotOccurrenceAt: r.slot_occurrence_at ? new Date(r.slot_occurrence_at) : null,
    slotId: r.slot_id,
    publishedAt: new Date(r.published_at),
    origin: r.origin,
    externalId: r.external_id,
    frozenWithoutReading: r.frozen_without_reading,
    voiceProfile: r.vp_id ? { id: r.vp_id, recordedName: r.vp_recorded_name ?? "", liveName: r.vp_live_name } : null,
    seriesKind: r.series_id
      ? {
          id: r.series_id,
          occurrenceRule: r.series_occurrence_rule!,
          recordedName: r.series_recorded_name ?? "",
          liveName: r.series_live_name,
        }
      : null,
    metricKey: r.metric_key,
    value: r.value === null ? null : Number(r.value),
    capturedAt: r.captured_at ? new Date(r.captured_at) : null,
  }));
}

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
