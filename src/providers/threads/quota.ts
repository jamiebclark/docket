export const QUOTA_RETRY_MS = 3_600_000;

export type QuotaReading = { usage: number; total: number } | null;

/** Defensive read of `GET /{user}/threads_publishing_limit?fields=quota_usage,config`; null when unreadable. */
export function readQuota(body: unknown): QuotaReading {
  const data = (body as { data?: unknown } | null)?.data;
  const row = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : undefined;
  if (!row || typeof row !== "object") return null;
  const usage = row.quota_usage;
  const total = (row.config as { quota_total?: unknown } | null | undefined)?.quota_total;
  if (typeof usage !== "number" || typeof total !== "number" || !Number.isFinite(usage) || !Number.isFinite(total) || total <= 0) {
    return null;
  }
  return { usage, total };
}
