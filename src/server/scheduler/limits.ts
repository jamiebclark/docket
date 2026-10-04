import type { PublishLimit } from "../../providers/types";

export interface AccountLimitFields {
  publishLimitCount: number | null;
  publishLimitWindowSeconds: number | null;
}

/** Every limit that applies to an account: the provider default and the account's own (the stricter one wins, D8). */
export function effectiveLimits(providerDefaults: readonly PublishLimit[], account: AccountLimitFields): PublishLimit[] {
  const out: PublishLimit[] = [...providerDefaults];
  if (account.publishLimitCount !== null && account.publishLimitWindowSeconds !== null) {
    out.push({ count: account.publishLimitCount, windowSeconds: account.publishLimitWindowSeconds });
  }
  return out;
}

/**
 * When a first step must wait until, or `null` if it may start now. `startedSince` returns the
 * `publish_started_at` values newer than a cutoff. The deferral is the oldest start in the window plus the window.
 */
export async function deferralTime(
  limits: readonly PublishLimit[],
  now: Date,
  startedSince: (since: Date) => Promise<Date[]>,
): Promise<Date | null> {
  let deferUntil: Date | null = null;
  for (const limit of limits) {
    const windowMs = limit.windowSeconds * 1000;
    const started = (await startedSince(new Date(now.getTime() - windowMs))).sort((a, b) => a.getTime() - b.getTime());
    if (started.length >= limit.count) {
      const until = new Date(started[0]!.getTime() + windowMs);
      if (!deferUntil || until > deferUntil) deferUntil = until;
    }
  }
  return deferUntil;
}
