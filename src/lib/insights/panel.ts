// lib/insights/panel: the single place a target's performance-panel state is decided
// (contracts/panel.md §2). Pure, total, no clock and no database.
import type { InsightsDeclaration } from "../../providers/types";

export type MetricRow = { label: string; value: number };
export type Snapshot = { capturedAt: Date; rows: MetricRow[] };

export type TargetInsightsView =
  | { state: "not_published" }
  | { state: "no_external_id" }
  | { state: "platform_unsupported"; providerName: string }
  | { state: "unavailable"; reason: string; docsPath?: string }
  | { state: "not_polled_yet"; firstReadDueAt: Date | null }
  | { state: "nothing_reported"; capturedAt: Date }
  | { state: "reported"; capturedAt: Date; rows: MetricRow[] }
  | { state: "gone"; snapshot: Snapshot | null }
  | { state: "failing"; since: Date; reason: string; snapshot: Snapshot | null };

export interface BuildTargetInsightsViewInput {
  status: string;
  externalId: string | null;
  declaration: InsightsDeclaration | null;
  providerName: string;
  snapshot: { capturedAt: Date; metrics: Record<string, unknown> } | null;
  pollState: {
    nextPollAt: Date | null;
    consecutiveFailures: number;
    failingSince: Date | null;
    lastError: string | null;
    frozenReason: string | null;
  } | null;
  now: Date;
}

/** Only the declared keys present in `metrics`, in declaration order, each with the provider's own label. */
function rowsFor(declaration: InsightsDeclaration, metrics: Record<string, unknown>): MetricRow[] {
  const rows: MetricRow[] = [];
  for (const { key, label } of declaration.post) {
    const value = metrics[key];
    if (typeof value === "number") rows.push({ label, value });
  }
  return rows;
}

function snapshotFor(
  declaration: InsightsDeclaration,
  snapshot: { capturedAt: Date; metrics: Record<string, unknown> } | null,
): Snapshot | null {
  if (!snapshot) return null;
  return { capturedAt: snapshot.capturedAt, rows: rowsFor(declaration, snapshot.metrics) };
}

/** The ordered decision table of contracts/panel.md §2. `input.now` is accepted for injectability; it decides nothing here. */
export function buildTargetInsightsView(input: BuildTargetInsightsViewInput): TargetInsightsView {
  const { status, externalId, declaration, pollState, snapshot } = input;

  if (status !== "published") return { state: "not_published" };
  if (!declaration) return { state: "platform_unsupported", providerName: input.providerName };
  if (declaration.unavailable) return { state: "unavailable", reason: declaration.unavailable.reason, docsPath: declaration.unavailable.docsPath };
  if (externalId === null) return { state: "no_external_id" };
  if (pollState?.frozenReason === "gone") return { state: "gone", snapshot: snapshotFor(declaration, snapshot) };
  if (pollState && pollState.consecutiveFailures > 0) {
    return { state: "failing", since: pollState.failingSince!, reason: pollState.lastError ?? "", snapshot: snapshotFor(declaration, snapshot) };
  }
  if (!snapshot) return { state: "not_polled_yet", firstReadDueAt: pollState?.nextPollAt ?? null };
  const rows = rowsFor(declaration, snapshot.metrics);
  if (rows.length === 0) return { state: "nothing_reported", capturedAt: snapshot.capturedAt };
  return { state: "reported", capturedAt: snapshot.capturedAt, rows };
}
