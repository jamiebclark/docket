// services/usage: the Usage screen's report, and the job page's own-job totals (contracts/services.md §4).
import { USAGE_PURPOSE_LABELS } from "../../lib/generation/usage-purpose";
import { usagePeriodWindow, type UsagePeriod } from "../../lib/generation/usage-period";
import type { ModelTotals, PurposeTotals, UsageTotals } from "../dal/llm-usage";
import { requirePermission, type ProjectScope } from "../dal/scope";
import { estimateMicros, getLlmRates, rateFor } from "../llm/rates";

export type { UsagePeriod, UsageTotals };
export { USAGE_PERIODS, DEFAULT_USAGE_PERIOD } from "../../lib/generation/usage-period";

/** The one sentence that carries every money figure (FR-020, SC-005). */
export const ESTIMATE_DISCLAIMER =
  "Estimated upper bound from the rates this install has configured. Docket ships no prices and fetches none, and has no way to know what the provider's invoice will say.";

export interface ModelUsageRow extends ModelTotals {
  /** Present only when a rate matched; absent (not zero) otherwise (FR-021). */
  estimateMicros?: number;
  /** True when the matched rate is 0 — a configured zero, not a missing one (M11, FR-012). */
  rateIsZero?: boolean;
}

export interface UsageView {
  period: UsagePeriod;
  /** Resolved in the project's zone; `null` bounds mean open (M17, SC-013). */
  window: { from: Date | null; to: Date | null };
  timeZone: string;
  totals: UsageTotals;
  byModel: ModelUsageRow[];
  byPurpose: (PurposeTotals & { label: string })[];
  /** Absent when no rate at all is configured — the money column does not exist (M14, FR-023). */
  money?: {
    currency: string;
    /** Over priced models only; always carried by ESTIMATE_DISCLAIMER (FR-019, FR-022). */
    totalMicros: number;
    pricedModels: number;
    /** Named in the total, with their counts (FR-022, SC-004). */
    excluded: { provider: string; model: string; calls: number; tokens: number }[];
    /** True when rates exist but nothing in this period matched one (FR-024, US3 scenario 3). */
    noPricedUsage: boolean;
  };
}

/** Owner and admin only, on the existing permission. Throws ForbiddenError otherwise (FR-026). */
export async function getProjectUsage(scope: ProjectScope, period: UsagePeriod): Promise<UsageView> {
  requirePermission(scope, { llm_credential: ["manage"] });
  const timeZone = scope.project.timezone;
  const window = usagePeriodWindow(period, timeZone, new Date());
  const [totals, byModel, byPurpose] = await Promise.all([
    scope.llmUsage.summary(window),
    scope.llmUsage.byModel(window),
    scope.llmUsage.byPurpose(window),
  ]);

  const rates = getLlmRates();
  let byModelRows: ModelUsageRow[] = byModel;
  let money: UsageView["money"];
  if (rates.entries.length > 0) {
    byModelRows = byModel.map((row) => {
      const rate = rateFor(rates, row.provider, row.model);
      if (!rate) return row;
      const micros = estimateMicros(row.inputTokens, rate.inputMicrosPerMillion) + estimateMicros(row.outputTokens, rate.outputMicrosPerMillion);
      return { ...row, estimateMicros: micros, rateIsZero: rate.inputMicrosPerMillion === 0 && rate.outputMicrosPerMillion === 0 };
    });
    const priced = byModelRows.filter((row) => row.estimateMicros !== undefined);
    const excluded = byModelRows
      .filter((row) => row.estimateMicros === undefined)
      .map((row) => ({ provider: row.provider, model: row.model, calls: row.calls, tokens: row.inputTokens + row.outputTokens }));
    money = {
      currency: rates.currency!,
      totalMicros: priced.reduce((n, row) => n + (row.estimateMicros ?? 0), 0),
      pricedModels: priced.length,
      excluded,
      noPricedUsage: priced.length === 0 && byModelRows.length > 0,
    };
  }

  return {
    period,
    window,
    timeZone,
    totals,
    byModel: byModelRows,
    byPurpose: byPurpose.map((row) => ({ ...row, label: USAGE_PURPOSE_LABELS[row.purpose] })),
    money,
  };
}

/** Calls and tokens for one job, for the job page. No money (P19). */
export function getJobUsage(scope: ProjectScope, jobId: string): Promise<UsageTotals> {
  return scope.llmUsage.totalsForJob(jobId);
}
