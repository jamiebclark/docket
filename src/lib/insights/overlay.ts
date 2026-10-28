// lib/insights/overlay: every account's numbers for one post, laid out as a single matrix
// (metric down, account across). Pure, total, no clock and no database.
import type { MetricRow, TargetInsightsView } from "./panel";

export interface OverlaySubject {
  targetId: string;
  accountName: string;
  providerKey: string;
  providerName: string;
  view: TargetInsightsView;
}

/** One account that has at least one number: a column of the matrix. */
export interface OverlayColumn {
  targetId: string;
  accountName: string;
  providerKey: string;
  providerName: string;
  capturedAt: Date;
  /** Label to value, exactly as the provider declared the label. Never merged, never summed. */
  values: ReadonlyMap<string, number>;
  /** Set when the numbers are real but final or stale — "No longer on Threads", "Reads are failing". */
  caveat: string | null;
}

/** One account with no numbers to show: a line under the matrix, never a column of blanks. */
export interface OverlayAbsence {
  targetId: string;
  accountName: string;
  providerKey: string;
  providerName: string;
  /** A few words for the list; the full sentence stays `PerformanceNote`'s job. */
  summary: string;
}

export interface PostPerformanceOverlay {
  /** Metric labels down the side, in the order the accounts first used them. */
  labels: readonly string[];
  columns: readonly OverlayColumn[];
  absences: readonly OverlayAbsence[];
  /** The newest reading across every column; null when there are none. */
  asOf: Date | null;
}

/**
 * A short phrase per state, for the list under the matrix. Deliberately **not** the provider's own
 * `reason`: that is a whole sentence and belongs beside the account, not in a summary line.
 */
function summaryFor(view: TargetInsightsView): string {
  switch (view.state) {
    case "not_published":
      return "Not published yet";
    case "platform_unsupported":
      return `Docket cannot read numbers from ${view.providerName} yet`;
    case "unavailable":
      return "Not available";
    case "permission_not_requested":
      return "Permission not requested";
    case "needs_reconnect":
      return "Needs a reconnect";
    case "no_external_id":
      return "Recorded by hand";
    case "unqueryable":
      return "Cannot be read";
    case "gone":
      return "No longer on the platform";
    case "expired":
      return "Expired";
    case "failing":
      return "Reads are failing";
    case "not_polled_yet":
      return "Waiting on the first read";
    case "nothing_reported":
      return "Nothing reported yet";
    case "reported":
      return "";
  }
}

/**
 * A whole sentence for a column whose numbers are real but final or stale, so the matrix can keep
 * showing them without implying they are still moving. A column states its own reading time, so
 * none of these repeats it.
 */
function caveatFor(view: TargetInsightsView, providerName: string): string {
  switch (view.state) {
    case "gone":
      return `This post is no longer on ${providerName}; these numbers are the last ones read.`;
    case "expired":
      return "This story has expired; these numbers are final.";
    case "failing":
      return `Reads have been failing since the time shown; these numbers are the last ones read.`;
    case "unqueryable":
      return `${view.reason} These numbers are the last ones read.`;
    default:
      return "";
  }
}

/**
 * The numbers a state carries, if any. Four states are terminal or degraded and still hold a
 * snapshot — those numbers are real and stay on screen, with `caveat` saying what they are.
 */
function numbersFor(
  view: TargetInsightsView,
  providerName: string,
): { rows: readonly MetricRow[]; capturedAt: Date; caveat: string | null } | null {
  switch (view.state) {
    case "reported":
      return { rows: view.rows, capturedAt: view.capturedAt, caveat: null };
    case "gone":
    case "expired":
    case "unqueryable":
    case "failing": {
      if (!view.snapshot || view.snapshot.rows.length === 0) return null;
      return { rows: view.snapshot.rows, capturedAt: view.snapshot.capturedAt, caveat: caveatFor(view, providerName) };
    }
    default:
      return null;
  }
}

/**
 * Lays every account's latest reading side by side for one post.
 *
 * **What this does not do.** It never adds, averages or otherwise combines two accounts' numbers,
 * and it never renames a metric: a row exists because some provider declared that exact label, and
 * each cell holds one provider's own figure under it. Two platforms that both say "Views" share a
 * row because they both chose that word — not because Docket decided the two are the same event,
 * which they are not. The screen says so, and the per-platform figures stay separate so a reader
 * can see the difference rather than have it hidden inside one number.
 *
 * An account with nothing to show becomes an `absence` rather than a column of blanks: a dead
 * column is harder to read than a sentence, and a blank cell invites being read as a zero.
 */
export function buildPostPerformanceOverlay(subjects: readonly OverlaySubject[]): PostPerformanceOverlay {
  const columns: OverlayColumn[] = [];
  const absences: OverlayAbsence[] = [];
  const labels: string[] = [];
  const seen = new Set<string>();

  for (const subject of subjects) {
    const numbers = numbersFor(subject.view, subject.providerName);
    if (!numbers) {
      absences.push({
        targetId: subject.targetId,
        accountName: subject.accountName,
        providerKey: subject.providerKey,
        providerName: subject.providerName,
        summary: summaryFor(subject.view),
      });
      continue;
    }
    const values = new Map<string, number>();
    for (const row of numbers.rows) {
      // A provider cannot declare one label twice, so first-wins here only guards a malformed
      // declaration; it must not let a later row silently replace an earlier one.
      if (!values.has(row.label)) values.set(row.label, row.value);
      if (!seen.has(row.label)) {
        seen.add(row.label);
        labels.push(row.label);
      }
    }
    columns.push({
      targetId: subject.targetId,
      accountName: subject.accountName,
      providerKey: subject.providerKey,
      providerName: subject.providerName,
      capturedAt: numbers.capturedAt,
      values,
      caveat: numbers.caveat,
    });
  }

  // Rows that more accounts report come first. A matrix of six platforms' labels is mostly
  // not-reported marks, and a row only one account answers is a fact about that account rather
  // than a comparison — sinking those puts everything worth reading across the top, and keeps the
  // sparse tail together instead of scattered through the middle. Ties keep declaration order,
  // which is the provider's own, so this reorders between metrics and never inside one platform's.
  const coverage = (label: string) => columns.filter((c) => c.values.has(label)).length;
  const ordered = labels
    .map((label, at) => ({ label, at, by: coverage(label) }))
    .sort((a, b) => b.by - a.by || a.at - b.at)
    .map((l) => l.label);

  const asOf = columns.reduce<Date | null>((newest, c) => (newest === null || c.capturedAt > newest ? c.capturedAt : newest), null);
  return { labels: ordered, columns, absences, asOf };
}
