// services/usage: the Usage screen's report, and the job page's own-job totals (contracts/services.md §4).
import { USAGE_PURPOSE_LABELS } from "../../lib/generation/usage-purpose";
import { usagePeriodWindow, type UsagePeriod } from "../../lib/generation/usage-period";
import type { ModelTotals, PurposeTotals, UsageTotals } from "../dal/llm-usage";
import { requirePermission, type ProjectScope } from "../dal/scope";

export type { UsagePeriod, UsageTotals };
export { USAGE_PERIODS, DEFAULT_USAGE_PERIOD } from "../../lib/generation/usage-period";

/** The one sentence that carries every money figure (FR-020, SC-005). Filled in by US2. */
export const ESTIMATE_DISCLAIMER = "";

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
  return {
    period,
    window,
    timeZone,
    totals,
    byModel,
    byPurpose: byPurpose.map((row) => ({ ...row, label: USAGE_PURPOSE_LABELS[row.purpose] })),
  };
}

/** Calls and tokens for one job, for the job page. No money (P19). */
export function getJobUsage(scope: ProjectScope, jobId: string): Promise<UsageTotals> {
  return scope.llmUsage.totalsForJob(jobId);
}
