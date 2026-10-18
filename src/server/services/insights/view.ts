// services/insights/view: the Insights page's account-trends read (US1), the one function the
// page and the future API operation both call.
import { findProvider } from "../../../providers/registry";
import { buildTrendSeries, type TrendSeries } from "../../../lib/insights/trend";
import { shapeNote } from "../../../lib/insights/shape";
import { accountTrendRows, type MetricReadingRow } from "../../dal/insights-read";
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
