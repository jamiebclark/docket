// scheduler/engagement-budget: the write-budget reserve, pure (research.md §8, FR-042, FR-043).
import type { PublishLimit } from "../../providers/types";

/** The stricter of the provider's engagement write budget and the account's own publish limit (research.md §8). */
export function stricterBudget(providerBudget: PublishLimit, accountLimit: PublishLimit | null): PublishLimit {
  if (!accountLimit) return providerBudget;
  const rate = (limit: PublishLimit) => limit.count / limit.windowSeconds;
  return rate(accountLimit) < rate(providerBudget) ? accountLimit : providerBudget;
}

/** The window start a reply's writes-in-window count must be taken from. */
export function windowStart(now: Date, budget: PublishLimit): Date {
  return new Date(now.getTime() - budget.windowSeconds * 1000);
}

/** `floor(budget.count × (1 − reserve))` — the ceiling replies may use of the account's own budget. */
export function reserveFloor(budget: PublishLimit, writeReserve: number): number {
  return Math.floor(budget.count * (1 - writeReserve));
}

export interface ReplyBudgetCheck {
  budget: PublishLimit;
  /** Writes already started in the window: `publish_started_at` rows plus engagement claims. */
  writesInWindow: number;
  writeReserve: number;
  /** Replies already sent this account this run. */
  sentThisRun: number;
  sendsPerTick: number;
}

export type ReplyBudgetVerdict = { ok: true } | { ok: false; reason: "write_allowance" | "per_run_cap" };

/** Whether another reply may be sent for this account right now (FR-042, FR-043). */
export function mayAttemptReply(check: ReplyBudgetCheck): ReplyBudgetVerdict {
  if (check.sentThisRun >= check.sendsPerTick) return { ok: false, reason: "per_run_cap" };
  if (check.writesInWindow >= reserveFloor(check.budget, check.writeReserve)) return { ok: false, reason: "write_allowance" };
  return { ok: true };
}
