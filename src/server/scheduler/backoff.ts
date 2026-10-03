/** D9: `min(BASE × 2^(attempt−1), MAX)`, no jitter, never earlier than `notBefore`. */
export function nextRetryAt(
  now: Date,
  attemptCount: number,
  cfg: { backoffBaseMs: number; backoffMaxMs: number },
  notBefore?: Date,
): Date {
  const exponent = Math.min(Math.max(attemptCount - 1, 0), 40);
  const delay = Math.min(cfg.backoffBaseMs * 2 ** exponent, cfg.backoffMaxMs);
  const at = now.getTime() + delay;
  return new Date(notBefore ? Math.max(at, notBefore.getTime()) : at);
}
