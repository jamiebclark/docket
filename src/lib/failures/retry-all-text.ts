export type RetryAllSkipReason =
  | "account_removed"
  | "needs_reconnecting"
  | "provider_unavailable"
  | "no_longer_failed"
  | "cannot_publish"
  | "no_free_slot";

export type SkipCounts = Record<RetryAllSkipReason, number>;

/** Display order for skip reasons (research D3). */
export const SKIP_REASONS: readonly RetryAllSkipReason[] = [
  "account_removed",
  "needs_reconnecting",
  "provider_unavailable",
  "no_longer_failed",
  "cannot_publish",
  "no_free_slot",
];

/** Phrases read as "{n} {phrase}", so counts count posts, not accounts (research P9). */
export const SKIP_PHRASES: Record<
  RetryAllSkipReason,
  { one: string; many: (n: number) => string }
> = {
  account_removed: { one: "1 on a removed account", many: (n) => `${n} on removed accounts` },
  needs_reconnecting: { one: "1 needs reconnecting", many: (n) => `${n} need reconnecting` },
  provider_unavailable: {
    one: "1 with an unavailable provider",
    many: (n) => `${n} with an unavailable provider`,
  },
  no_longer_failed: { one: "1 no longer failed", many: (n) => `${n} no longer failed` },
  cannot_publish: {
    one: "1 can't be published as is",
    many: (n) => `${n} can't be published as is`,
  },
  no_free_slot: { one: "1 no free slot", many: (n) => `${n} no free slot` },
};

export function skipPhrase(reason: RetryAllSkipReason, n: number): string {
  const phrase = SKIP_PHRASES[reason];
  return n === 1 ? phrase.one : phrase.many(n);
}

export function retryAllMessage(r: {
  mode: "now" | "requeue";
  inScope: number;
  count: number;
  skipped: SkipCounts;
  remaining: number;
}): string {
  if (r.inScope === 0) return "There are no failed posts to retry.";

  const parts: string[] = [];
  if (r.count === 0) parts.push("No posts were retried.");
  else if (r.mode === "now") {
    parts.push(r.count === 1 ? "1 post will be retried." : `${r.count} posts will be retried.`);
  } else {
    parts.push(
      r.count === 1
        ? "1 post was queued into the next free slot."
        : `${r.count} posts were queued into the next free slots.`,
    );
  }

  const total = SKIP_REASONS.reduce((sum, reason) => sum + r.skipped[reason], 0);
  if (total > 0) {
    const reasons = SKIP_REASONS.filter((reason) => r.skipped[reason] > 0).map((reason) =>
      skipPhrase(reason, r.skipped[reason]),
    );
    parts.push(`Skipped ${total}: ${reasons.join(", ")}.`);
  }

  if (r.remaining > 0) {
    parts.push(
      r.remaining === 1
        ? "1 more failed post was not retried yet."
        : `${r.remaining} more failed posts were not retried yet.`,
      "Press Retry all failed again to continue.",
    );
  }
  return parts.join(" ");
}
