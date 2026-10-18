const DAY_MS = 86_400_000;
const WINDOW_DAYS = 90;

function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function toDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface PinterestAnalyticsWindow {
  /** `YYYY-MM-DD`. */
  start: string;
  /** `YYYY-MM-DD`. */
  end: string;
}

/** Pure, total, no clock read inside (contracts/platform-readers-082.md §2, FR-030). */
export function pinterestAnalyticsWindow({ publishedAt, now }: { publishedAt: Date; now: Date }): PinterestAnalyticsWindow {
  const end = utcMidnight(now);
  const earliest = new Date(end.getTime() - WINDOW_DAYS * DAY_MS);
  const published = utcMidnight(publishedAt);
  const start = published.getTime() > earliest.getTime() ? published : earliest;
  return { start: toDateString(start), end: toDateString(end) };
}
