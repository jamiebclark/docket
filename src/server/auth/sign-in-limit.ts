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
