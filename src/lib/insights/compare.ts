// lib/insights/compare: rows + tz + range + dimension + metric -> Comparison (contracts/comparisons.md,
// data-model.md §7.2). Pure, total, no clock and no database. Every boundary — local day, weekday,
// local hour — is computed with @js-temporal/polyfill from the stored UTC instant in the project's
// current time zone, disambiguation "compatible" (contracts/comparisons.md §6).
import { Temporal } from "@js-temporal/polyfill";
import { PROVISIONAL_MIN, RANK_MIN, verdictFor } from "./floor";

export type Dimension = "slot" | "day_of_week" | "series_kind" | "voice_profile" | "origin";
export type Conclusion = "ranked" | "not_enough_posts";
export type GroupVerdict = "ranked" | "provisional";

export type ExclusionReason =
  | "no_external_id"
  | "no_snapshot"
  | "not_slot_scheduled"
  | "frozen_without_reading"
  | "series_unrecorded"
  | "metric_shape_unknown";

export interface ComparisonGroup {
  key: string;
  label: string;
  removed: boolean;
  sampleSize: number;
  mean: number;
  median: number;
  singleAccount: { id: string; name: string } | null;
  verdict: GroupVerdict;
}

export interface Exclusion {
  reason: ExclusionReason;
  count: number;
}

export interface Comparison {
  dimension: Dimension;
  providerKey: string;
  platform: string;
  metricKey: string;
  label: string;
  range: { from: string; to: string };
  timeZone: string;
  groups: ComparisonGroup[];
  suppressedGroupCount: number;
  exclusions: Exclusion[];
  conclusion: Conclusion;
  asOf: Date | null;
  /** The dimension has nothing to compare at all — e.g. the project has never used standing series. */
  refusal: string | null;
}

/** A named, removable fact (a voice profile or a series) — the recorded fact plus whether it's still live. */
export interface NamedFact {
  id: string;
  recordedName: string;
  liveName: string | null;
}

export interface ComparableRow {
  targetId: string;
  postId: string;
  accountId: string;
  accountName: string;
  providerKey: string;
  platform: string;
  metricKey: string;
  /** null when the metric's declared shape is `unknown` (metric_shape_unknown). */
  metricShapeKnown: boolean;
  scheduleKind: "slot" | "explicit" | "now";
  slotOccurrenceAt: Date | null;
  /** The slot's current project-local weekday+time label, or null when the slot row is gone. */
  slotLabel: NamedFact | null;
  publishedAt: Date;
  origin: "manual" | "generated" | "api";
  voiceProfile: NamedFact | null;
  seriesKind: { occurrenceRule: "cadence" | "dated_list" } & NamedFact | null;
  externalId: string | null;
  /** True for a target frozen gone/expired/unqueryable/failing with no snapshot ever (frozen_without_reading). */
  frozenWithoutReading: boolean;
  /** The latest value for this row's metric key, or null when never reported. */
  value: number | null;
  capturedAt: Date | null;
}

export interface CompareInput {
  rows: readonly ComparableRow[];
  timeZone: string;
  range: { from: Date; to: Date };
  dimension: Dimension;
}

function toZoned(instant: Date, zone: string): Temporal.ZonedDateTime {
  return Temporal.Instant.fromEpochMilliseconds(instant.getTime()).toZonedDateTimeISO(zone);
}

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function weekdayOf(instant: Date, zone: string): string {
  return WEEKDAYS[toZoned(instant, zone).dayOfWeek - 1]!;
}

function slotKey(instant: Date, zone: string): { key: string; label: string } {
  const zdt = toZoned(instant, zone);
  const weekday = WEEKDAYS[zdt.dayOfWeek - 1]!;
  const time = zdt.toPlainTime().toString({ smallestUnit: "minute" });
  return { key: `${weekday} ${time}`, label: `${weekday} ${time}` };
}

function mean(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function singleAccountFor(rows: readonly ComparableRow[]): { id: string; name: string } | null {
  const first = rows[0];
  if (!first) return null;
  return rows.every((r) => r.accountId === first.accountId) ? { id: first.accountId, name: first.accountName } : null;
}

interface GroupKey {
  key: string;
  label: string;
  removed: boolean;
}

/** Assigns `row` to its group for `dimension`, or returns an `ExclusionReason` instead. */
function groupFor(row: ComparableRow, dimension: Dimension, zone: string): GroupKey | ExclusionReason {
  switch (dimension) {
    case "slot": {
      if (row.scheduleKind !== "slot") return "not_slot_scheduled";
      const { key, label } = slotKey(row.slotOccurrenceAt!, zone);
      if (row.slotLabel) return { key, label: row.slotLabel.liveName ?? label, removed: false };
      return { key, label: `${label} (removed)`, removed: true };
    }
    case "day_of_week": {
      const at = row.scheduleKind === "slot" ? row.slotOccurrenceAt! : row.publishedAt;
      const weekday = weekdayOf(at, zone);
      return { key: weekday, label: weekday, removed: false };
    }
    case "series_kind": {
      if (!row.seriesKind) return "series_unrecorded";
      const label = row.seriesKind.occurrenceRule === "cadence" ? "Evergreen" : "Date-pegged";
      const removed = row.seriesKind.liveName === null;
      return { key: row.seriesKind.occurrenceRule, label: removed ? `${label} (removed)` : label, removed };
    }
    case "voice_profile": {
      if (!row.voiceProfile) return { key: "not_generated", label: "Not generated", removed: false };
      const removed = row.voiceProfile.liveName === null;
      const name = removed ? `${row.voiceProfile.recordedName} (removed)` : row.voiceProfile.liveName!;
      return { key: row.voiceProfile.id, label: name, removed };
    }
    case "origin": {
      const labels: Record<ComparableRow["origin"], string> = { manual: "Manual", generated: "Generated", api: "API" };
      return { key: row.origin, label: labels[row.origin], removed: false };
    }
  }
}

/**
 * Pure `rows + tz + range + dimension + metric -> Comparison`. Exclusions are counted, never zeros
 * (contracts/comparisons.md §5); ranking needs two or more groups at `RANK_MIN` (§1); mean and
 * median are both reported (§4).
 */
export function compare(input: CompareInput): Comparison {
  const { timeZone, range, dimension } = input;
  const first = input.rows[0];
  const providerKey = first?.providerKey ?? "";
  const platform = first?.platform ?? "";
  const metricKey = first?.metricKey ?? "";
  // FR-034: a Comparison carries exactly one providerKey and one metricKey — rows for any other
  // platform or metric never contribute a bar to this one (US3.7).
  const rows = input.rows.filter((r) => r.providerKey === providerKey && r.metricKey === metricKey);

  const exclusionCounts = new Map<ExclusionReason, number>();
  const bump = (reason: ExclusionReason) => exclusionCounts.set(reason, (exclusionCounts.get(reason) ?? 0) + 1);

  const groups = new Map<string, { label: string; removed: boolean; rows: ComparableRow[] }>();
  let asOf: Date | null = null;

  for (const row of rows) {
    if (row.capturedAt && (!asOf || row.capturedAt > asOf)) asOf = row.capturedAt;
    if (!row.metricShapeKnown) {
      bump("metric_shape_unknown");
      continue;
    }
    if (row.externalId === null) {
      bump("no_external_id");
      continue;
    }
    if (row.value === null) {
      if (row.frozenWithoutReading) bump("frozen_without_reading");
      else bump("no_snapshot");
      continue;
    }

    const assignment = groupFor(row, dimension, timeZone);
    if (typeof assignment === "string") {
      bump(assignment);
      continue;
    }
    const existing = groups.get(assignment.key);
    if (existing) existing.rows.push(row);
    else groups.set(assignment.key, { label: assignment.label, removed: assignment.removed, rows: [row] });
  }

  let suppressedGroupCount = 0;
  const comparisonGroups: ComparisonGroup[] = [];
  for (const [key, group] of groups) {
    const verdict = verdictFor(group.rows.length);
    if (verdict === "suppressed") {
      suppressedGroupCount++;
      continue;
    }
    const values = group.rows.map((r) => r.value!);
    comparisonGroups.push({
      key,
      label: group.label,
      removed: group.removed,
      sampleSize: group.rows.length,
      mean: mean(values),
      median: median(values),
      singleAccount: singleAccountFor(group.rows),
      verdict,
    });
  }

  const rankedCount = comparisonGroups.filter((g) => g.verdict === "ranked").length;
  const conclusion: Conclusion = rankedCount >= 2 ? "ranked" : "not_enough_posts";

  const ordered =
    conclusion === "ranked"
      ? [...comparisonGroups].sort((a, b) => b.mean - a.mean)
      : [...comparisonGroups].sort((a, b) => a.label.localeCompare(b.label));

  const exclusions: Exclusion[] = [...exclusionCounts.entries()].map(([reason, count]) => ({ reason, count }));

  let refusal: string | null = null;
  if (rows.length === 0) refusal = "No comparable posts in this range yet.";
  else if (dimension === "series_kind" && comparisonGroups.length === 0 && suppressedGroupCount === 0) {
    refusal = "This project has not used standing series.";
  } else if (dimension === "voice_profile" && new Set(rows.map((r) => r.voiceProfile?.id ?? "none")).size <= 1) {
    refusal = "This project has not generated with more than one voice profile.";
  } else if (dimension === "origin" && new Set(rows.map((r) => r.origin)).size <= 1) {
    refusal = "This project's posts all share one origin.";
  }

  return {
    dimension,
    providerKey,
    platform,
    metricKey,
    label: metricKey,
    range: { from: range.from.toISOString(), to: range.to.toISOString() },
    timeZone,
    groups: ordered,
    suppressedGroupCount,
    exclusions,
    conclusion,
    asOf,
    refusal,
  };
}

export { RANK_MIN, PROVISIONAL_MIN };
