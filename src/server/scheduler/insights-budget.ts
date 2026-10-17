// scheduler/insights-budget: the per-account read-budget reserve, pure arithmetic over counts the
// caller already read (research.md §4, contracts/scheduler-insights.md §3 step 3, FR-045 … FR-049).
import type { PublishLimit } from "../../providers/types";
import { reserveFloor, stricterBudget, windowStart } from "./engagement-budget";
import { writesStartedSince } from "../dal/scheduler";

export { reserveFloor, stricterBudget, windowStart };

export type InsightsBudgetVerdict = { ok: true } | { ok: false; reason: "read_allowance" };

export interface InsightsAllowanceCounters {
  countForAccountSince(socialAccountId: string, since: Date): Promise<number>;
}

/**
 * The reserve check a poll must pass before any provider call (FR-045). `usedInWindow` is the
 * window count of research.md §4 — writes already started plus insights snapshots already
 * captured — never a new ledger row.
 */
export async function checkInsightsAllowance(input: {
  projectId: string;
  socialAccountId: string;
  providerBudget: PublishLimit;
  accountPublishLimit: PublishLimit | null;
  now: Date;
  readReserve: number;
  postSnapshots: InsightsAllowanceCounters;
  accountSnapshots: InsightsAllowanceCounters;
}): Promise<InsightsBudgetVerdict> {
  const budget = stricterBudget(input.providerBudget, input.accountPublishLimit);
  const since = windowStart(input.now, budget);
  const [writesStarted, postSnapshotCount, accountSnapshotCount] = await Promise.all([
    writesStartedSince(input.projectId, input.socialAccountId, since),
    input.postSnapshots.countForAccountSince(input.socialAccountId, since),
    input.accountSnapshots.countForAccountSince(input.socialAccountId, since),
  ]);
  const usedInWindow = writesStarted.length + postSnapshotCount + accountSnapshotCount;
  if (usedInWindow >= reserveFloor(budget, input.readReserve)) return { ok: false, reason: "read_allowance" };
  return { ok: true };
}
