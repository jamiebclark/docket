import { SKIP_REASONS, skipPhrase } from "@/lib/failures/retry-all-text";
import type { RetryAllPreview, RetryAllResult } from "@/server/services/posts";

export type RetryAllMode = "now" | "requeue";

export const UNEXPECTED_ERROR = "Some posts may have been retried. Reload the page to see where things stand.";

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

export function retryAllLabel(count: number, accountName: string | null): string {
  const suffix = accountName ? ` for ${accountName}` : "";
  return count === 1 ? `Retry 1 failed post${suffix}` : `Retry all ${count} failed posts${suffix}`;
}

export function retryAllTitle(accountName: string | null): string {
  return accountName ? `Retry all failed posts for ${accountName}` : "Retry all failed posts";
}

export function previewLines(p: RetryAllPreview): { counts: string[]; blocked: string[] } {
  const where = p.scope ? `in ${p.scope.accountName}` : "across all accounts";
  const counts = [`${p.inScope} failed ${plural(p.inScope, "post", "posts")} ${where}.`];
  counts.push(
    p.capApplies
      ? `Up to ${p.cap} will be retried in this step; press again to continue.`
      : `${p.willAttempt} will be retried.`,
  );
  const blocked: string[] = [];
  let total = 0;
  for (const reason of SKIP_REASONS) {
    const n = (p.blocked as Record<string, number>)[reason] ?? 0;
    if (n > 0) {
      total += n;
      blocked.push(skipPhrase(reason, n));
    }
  }
  if (total > 0) counts.push(`${total} can't be retried yet:`);
  return { counts, blocked };
}

export function canConfirmAll(p: RetryAllPreview | "loading" | null): boolean {
  return typeof p === "object" && p !== null && p.willAttempt > 0;
}

export function confirmAllLabel(mode: RetryAllMode): string {
  return mode === "now" ? "Retry now" : "Requeue posts";
}

/** True when failed targets are still listed after the run, so the button survives the refresh (research P11). */
export function controlRemains(r: RetryAllResult): boolean {
  const skipped = SKIP_REASONS.reduce((sum, k) => sum + r.skipped[k], 0) - r.skipped.no_longer_failed;
  return r.remaining + skipped > 0;
}

export function summaryAccounts(r: RetryAllResult): { name: string; line: string }[] {
  const rows = r.accounts
    .map((a) => {
      const phrases = SKIP_REASONS.filter((k) => a.skipped[k] > 0).map((k) => skipPhrase(k, a.skipped[k]));
      if (a.remaining > 0) phrases.push(`${a.remaining} not retried yet`);
      return { name: a.name, retried: a.retried, phrases };
    })
    .filter((a) => a.phrases.length > 0);
  if (rows.length <= 1) return [];
  return rows.map((a) => ({ name: a.name, line: `${a.name}: ${a.retried} retried, ${a.phrases.join(", ")}` }));
}
