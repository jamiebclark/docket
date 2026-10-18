// services/insights/view: the Insights page's account-trends and comparisons reads (US1, US3, US4),
// the one module the page and the future API operation both call.
import { findProvider } from "../../../providers/registry";
import { buildTrendSeries, type TrendSeries } from "../../../lib/insights/trend";
import { shapeNote } from "../../../lib/insights/shape";
import { compare, type ComparableRow, type Comparison, type Dimension } from "../../../lib/insights/compare";
import {
  accountTrendRows,
  comparableTargetRows,
  type ComparableTargetRow,
  type MetricReadingRow,
} from "../../dal/insights-read";
import type { AccountMetricPollStatesRepo } from "../../dal/insights";

export type TrendNote =
  /** FR-015: a platform with no declared account metrics gets a line, never an empty chart. */
  | { kind: "platform_no_account_metrics"; providerKey: string; platform: string }
  /** US1.6, FR-004: an `unknown`-shaped key is absent from the trend, its reason shown instead. */
  | { kind: "unknown_metric_shape"; providerKey: string; platform: string; metricKey: string; label: string; reason: string };

export interface AccountTrendsView {
  series: TrendSeries[];
  trendNotes: TrendNote[];
}

export interface TrendAccountInput {
  id: string;
  displayName: string;
  providerKey: string;
}

export interface AccountTrendsInput {
  projectId: string;
  timeZone: string;
  accounts: readonly TrendAccountInput[];
  range: { from: Date; to: Date };
  accountMetricPollStates: AccountMetricPollStatesRepo;
}

function groupByKey<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const list = grouped.get(key(row));
    if (list) list.push(row);
    else grouped.set(key(row), [row]);
  }
  return grouped;
}

/**
 * One `TrendSeries` per account per declared account-metric key, plus a `TrendNote` for every
 * platform with no account metrics at all (FR-015) and every key whose shape is `unknown`
 * (US1.6, FR-004). Reads folded points and surviving snapshots together (contracts/fold.md §4).
 */
export async function buildAccountTrends(input: AccountTrendsInput): Promise<AccountTrendsView> {
  const series: TrendSeries[] = [];
  const trendNotes: TrendNote[] = [];
  if (input.accounts.length === 0) return { series, trendNotes };

  const accountIds = input.accounts.map((a) => a.id);
  const [rows, pollStates] = await Promise.all([
    accountTrendRows(input.projectId, accountIds, input.range.from, input.range.to),
    input.accountMetricPollStates.getMany(accountIds),
  ]);
  const rowsByAccount = groupByKey(rows, (r) => r.subjectId);

  for (const account of input.accounts) {
    const provider = findProvider(account.providerKey);
    const platform = provider?.displayName ?? account.providerKey;
    const declaredKeys = provider?.insights?.declaration.account ?? [];
    if (declaredKeys.length === 0) {
      trendNotes.push({ kind: "platform_no_account_metrics", providerKey: account.providerKey, platform });
      continue;
    }
    const accountRows: readonly MetricReadingRow[] = rowsByAccount.get(account.id) ?? [];
    const rowsByMetric = groupByKey(accountRows, (r) => r.metricKey);
    const lastSuccessfulReadAt = pollStates.get(account.id)?.lastCapturedAt ?? null;

    for (const declared of declaredKeys) {
      const trend = buildTrendSeries({
        accountId: account.id,
        accountName: account.displayName,
        providerKey: account.providerKey,
        platform,
        metricKey: declared.key,
        label: declared.label,
        shape: declared.shape,
        rows: rowsByMetric.get(declared.key) ?? [],
        timeZone: input.timeZone,
        range: input.range,
        lastSuccessfulReadAt,
      });
      if (trend) series.push(trend);
      else {
        trendNotes.push({
          kind: "unknown_metric_shape",
          providerKey: account.providerKey,
          platform,
          metricKey: declared.key,
          label: declared.label,
          reason: shapeNote(declared.shape) ?? "",
        });
      }
    }
  }

  return { series, trendNotes };
}

const DIMENSIONS: readonly Dimension[] = ["slot", "day_of_week", "series_kind", "voice_profile", "origin"];

export interface ComparisonsInput {
  projectId: string;
  timeZone: string;
  range: { from: Date; to: Date };
}

/** One account's targets, reassembled from `comparableTargetRows`' per-(target, metric key) rows. */
interface TargetGroup {
  base: ComparableTargetRow;
  metrics: Map<string, { value: number; capturedAt: Date }>;
}

function groupByTarget(rows: readonly ComparableTargetRow[]): Map<string, TargetGroup> {
  const groups = new Map<string, TargetGroup>();
  for (const row of rows) {
    let group = groups.get(row.targetId);
    if (!group) {
      group = { base: row, metrics: new Map() };
      groups.set(row.targetId, group);
    }
    if (row.metricKey !== null && row.value !== null && row.capturedAt !== null) {
      group.metrics.set(row.metricKey, { value: row.value, capturedAt: row.capturedAt });
    }
  }
  return groups;
}

/**
 * Builds a `ComparableRow` for every target of `providerKey` against one declared metric key — the
 * shape `src/lib/insights/compare.ts` needs, with `value`/`metricShapeKnown` filled from the reading
 * (or absent, `null`) and the registry (contracts/comparisons.md §3; G38 keeps the registry out of the
 * DAL).
 */
function toComparableRows(
  targets: readonly TargetGroup[],
  providerKey: string,
  platform: string,
  metricKey: string,
  metricShapeKnown: boolean,
): ComparableRow[] {
  return targets.map(({ base, metrics }) => {
    const reading = metrics.get(metricKey) ?? null;
    return {
      targetId: base.targetId,
      postId: base.postId,
      accountId: base.accountId,
      accountName: base.accountName,
      providerKey,
      platform,
      metricKey,
      metricShapeKnown,
      scheduleKind: base.scheduleKind,
      slotOccurrenceAt: base.slotOccurrenceAt,
      slotLabel: base.slotId ? { id: base.slotId, recordedName: "slot", liveName: "slot" } : null,
      publishedAt: base.publishedAt,
      origin: base.origin,
      voiceProfile: base.voiceProfile,
      seriesKind: base.seriesKind,
      externalId: base.externalId,
      frozenWithoutReading: base.frozenWithoutReading,
      value: reading?.value ?? null,
      capturedAt: reading?.capturedAt ?? null,
    };
  });
}

/**
 * One `Comparison` per (dimension, provider, declared post metric key) — contracts/comparisons.md.
 * Reads `comparableTargetRows` once and reuses it across every dimension and metric key, per
 * research.md §6 ("Grouping is pure TypeScript, not five SQL statements").
 */
export async function buildComparisons(input: ComparisonsInput): Promise<Comparison[]> {
  const rows = await comparableTargetRows(input.projectId, input.range.from, input.range.to);
  if (rows.length === 0) return [];

  const byTarget = groupByTarget(rows);
  const byProvider = new Map<string, TargetGroup[]>();
  for (const group of byTarget.values()) {
    const list = byProvider.get(group.base.providerKey);
    if (list) list.push(group);
    else byProvider.set(group.base.providerKey, [group]);
  }

  const comparisons: Comparison[] = [];
  for (const [providerKey, targets] of byProvider) {
    const provider = findProvider(providerKey);
    const platform = provider?.displayName ?? providerKey;
    const declaredKeys = provider?.insights?.declaration.post ?? [];
    for (const declared of declaredKeys) {
      const metricShapeKnown = declared.shape.kind !== "unknown";
      const comparableRows = toComparableRows(targets, providerKey, platform, declared.key, metricShapeKnown);
      for (const dimension of DIMENSIONS) {
        comparisons.push({
          ...compare({ rows: comparableRows, timeZone: input.timeZone, range: input.range, dimension }),
          label: declared.label,
          platform,
        });
      }
    }
  }
  return comparisons;
}
