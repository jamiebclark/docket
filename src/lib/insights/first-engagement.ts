// lib/insights/first-engagement: the pure read-time precedence over a `target_first_engagement`
// row (data-model.md §4, §7.3; contracts/first-engagement.md §4).

export type FirstEngagementFigure =
  | { kind: "exact"; afterMs: number }
  | { kind: "bounded"; afterAtLeastMs: number; afterAtMostMs: number }
  | { kind: "within_first_reading"; afterAtMostMs: number }
  | { kind: "none_yet"; asOf: Date }
  | { kind: "never_observed"; asOf: Date; frozenReason: string }
  | { kind: "not_examined" };

export interface FirstEngagementRow {
  publishedAt: Date;
  exactFirstAt: Date | null;
  boundBeforeAt: Date | null;
  boundAfterAt: Date | null;
  scannedThrough: Date | null;
  /** `post_metric_poll_states.frozen_reason`; read elsewhere, never stored on this row (data-model.md §4). */
  frozenReason: "settled" | "gone" | "expired" | "unqueryable" | null;
}

const NEVER_OBSERVED_REASONS = new Set(["gone", "expired", "unqueryable"]);

/**
 * The precedence contracts/first-engagement.md §4 states: exact beats bound, a bound with both ends
 * is an interval, a bound with no lower end is an upper bound only, and absence is either "not yet
 * examined" or — for a target frozen with nothing ever observed — "never observed".
 */
export function firstEngagementFigure(row: FirstEngagementRow): FirstEngagementFigure {
  if (row.exactFirstAt) {
    return { kind: "exact", afterMs: row.exactFirstAt.getTime() - row.publishedAt.getTime() };
  }
  if (row.boundBeforeAt) {
    const afterAtMostMs = row.boundBeforeAt.getTime() - row.publishedAt.getTime();
    if (row.boundAfterAt) {
      return { kind: "bounded", afterAtLeastMs: row.boundAfterAt.getTime() - row.publishedAt.getTime(), afterAtMostMs };
    }
    return { kind: "within_first_reading", afterAtMostMs };
  }
  if (row.scannedThrough) {
    if (row.frozenReason && NEVER_OBSERVED_REASONS.has(row.frozenReason)) {
      return { kind: "never_observed", asOf: row.scannedThrough, frozenReason: row.frozenReason };
    }
    return { kind: "none_yet", asOf: row.scannedThrough };
  }
  return { kind: "not_examined" };
}
