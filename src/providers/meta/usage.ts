/** The only thing that leaves the header. Two bounded integers: no key, no id, no raw text. */
export interface UsageSignal {
  /** The largest of call_count / total_cputime / total_time across every id, 0-100 (clamped). */
  maxPercent: number;
  /** The largest estimated_time_to_regain_access in minutes, or null when none was reported. */
  retryAfterMinutes: number | null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Pure and total. Null when the header is absent, unparseable or carries no usable number. */
export function parseUsageHeader(value: string | null): UsageSignal | null {
  if (!value) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;

  let maxPercent: number | null = null;
  let retryAfterMinutes: number | null = null;

  for (const entries of Object.values(parsed)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      for (const field of ["call_count", "total_cputime", "total_time"]) {
        const raw = record[field];
        if (typeof raw === "number" && Number.isFinite(raw)) {
          const percent = clamp(raw, 0, 100);
          maxPercent = maxPercent === null ? percent : Math.max(maxPercent, percent);
        }
      }
      const retry = record.estimated_time_to_regain_access;
      if (typeof retry === "number" && Number.isFinite(retry)) {
        const minutes = clamp(retry, 0, 1440);
        retryAfterMinutes = retryAfterMinutes === null ? minutes : Math.max(retryAfterMinutes, minutes);
      }
    }
  }

  if (maxPercent === null) return null;
  return { maxPercent, retryAfterMinutes };
}

/**
 * Process-local, per-account backoff set when a response's usage reached the ceiling (contracts/meta-usage.md §3).
 * Not persisted: a restart, or a later call once `retryAt` has passed, starts clean — this is a request-rate
 * backoff within the current run, not a stored copy of Meta's percentage.
 */
const backoffs = new Map<string, Date>();

/** The still-active backoff for `accountId`, or null when none is set or it has passed (and is cleared). */
export function activeUsageBackoff(accountId: string, now: Date): Date | null {
  const until = backoffs.get(accountId);
  if (!until) return null;
  if (until <= now) {
    backoffs.delete(accountId);
    return null;
  }
  return until;
}

/** Records that further reads for `accountId` should back off until `retryAt`. */
export function recordUsageBackoff(accountId: string, retryAt: Date): void {
  backoffs.set(accountId, retryAt);
}

/** Clears every recorded backoff. Test-only. */
export function resetUsageBackoffs(): void {
  backoffs.clear();
}
