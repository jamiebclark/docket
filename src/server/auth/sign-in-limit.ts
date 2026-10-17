/** In-memory fixed-window attempt counter keyed on a normalised email. */
export function createEmailAttemptLimiter({ max, windowMs }: { max: number; windowMs: number }) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return {
    /** Records an attempt; returns false once the email is over its limit for the window. */
    attempt(email: string, now = Date.now()): boolean {
      const key = email.trim().toLowerCase();
      if (hits.size > 10_000) {
        for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
      }
      const entry = hits.get(key);
      if (!entry || entry.resetAt <= now) {
        hits.set(key, { count: 1, resetAt: now + windowMs });
        return true;
      }
      entry.count += 1;
      return entry.count <= max;
    },
  };
}

/**
 * Fixed-window counter with no key: a ceiling on how often one thing may happen process-wide.
 *
 * It exists for the reset-request endpoint, which is unauthenticated and causes an email to be sent.
 * The per-email limiter above bounds how often ONE address can be mailed, but not how many distinct
 * addresses one caller can walk through — and `/forgot-password` reaches the endpoint in-process,
 * where Better Auth's per-IP limiter never runs. Without a ceiling, a single client could ask for
 * resets across thousands of addresses and have Docket mail every real one of them.
 *
 * The limit is deliberately far above any genuine use on a Docket install, so it is a ceiling on abuse
 * rather than a quota anyone can hit by hand.
 */
export function createGlobalAttemptLimiter({ max, windowMs }: { max: number; windowMs: number }) {
  let count = 0;
  let resetAt = 0;
  return {
    attempt(now = Date.now()): boolean {
      if (resetAt <= now) {
        count = 1;
        resetAt = now + windowMs;
        return true;
      }
      count += 1;
      return count <= max;
    },
  };
}
