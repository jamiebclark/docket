// lib/insights/panel: the single place a target's performance-panel state is decided
// (contracts/panel.md §2, contracts/panel-and-accounts.md §1). Pure, total, no clock and no database.
import type { InsightsDeclaration } from "../../providers/types";
import type { InsightsPermission } from "./eligibility";

export type MetricRow = { label: string; value: number };
export type Snapshot = { capturedAt: Date; rows: MetricRow[] };

export type TargetInsightsView =
  | { state: "not_published" }
  | { state: "platform_unsupported"; providerName: string }
  | { state: "unavailable"; reason: string; docsPath?: string }
  /** G33 (FR-025). Neither carries a number, a dash or a zero. */
  | { state: "permission_not_requested"; reason: string; docsPath?: string }
  | { state: "needs_reconnect"; reason: string; docsPath?: string; canReconnect: boolean }
  | { state: "no_external_id" }
  /** FR-036. Terminal: the stored external id cannot be queried; snapshots captured before this was known are kept, never a failure. */
  | { state: "unqueryable"; reason: string; snapshot: Snapshot | null }
  | { state: "gone"; snapshot: Snapshot | null }
  /** FR-042. Terminal for an ephemeral subject past its lifetime; numbers captured while it lived are final, never a failure. */
  | { state: "expired"; snapshot: Snapshot | null }
  | { state: "failing"; since: Date; reason: string; snapshot: Snapshot | null }
  | { state: "not_polled_yet"; firstReadDueAt: Date | null }
  | { state: "nothing_reported"; capturedAt: Date }
  | { state: "reported"; capturedAt: Date; rows: MetricRow[] };

export interface BuildTargetInsightsViewInput {
  status: string;
  externalId: string | null;
  declaration: InsightsDeclaration | null;
  providerName: string;
  /** G33. `null` when this provider declares no insights or needs no permission. */
  permission: InsightsPermission | null;
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
  if (input.permission?.kind === "not_requested") {
    return { state: "permission_not_requested", reason: input.permission.reason, docsPath: input.permission.docsPath };
  }
  if (input.permission?.kind === "not_granted") {
    return { state: "needs_reconnect", reason: input.permission.reason, docsPath: input.permission.docsPath, canReconnect: input.permission.canReconnect };
  }
  if (externalId === null) return { state: "no_external_id" };
  if (pollState?.frozenReason === "gone") return { state: "gone", snapshot: snapshotFor(declaration, snapshot) };
  if (pollState?.frozenReason === "unqueryable") {
    return { state: "unqueryable", reason: "This post's stored platform id cannot be used to request its numbers.", snapshot: snapshotFor(declaration, snapshot) };
  }
  if (pollState?.frozenReason === "expired") return { state: "expired", snapshot: snapshotFor(declaration, snapshot) };
  if (pollState && pollState.consecutiveFailures > 0) {
    return { state: "failing", since: pollState.failingSince!, reason: pollState.lastError ?? "", snapshot: snapshotFor(declaration, snapshot) };
  }
  if (!snapshot) return { state: "not_polled_yet", firstReadDueAt: pollState?.nextPollAt ?? null };
  const rows = rowsFor(declaration, snapshot.metrics);
  if (rows.length === 0) return { state: "nothing_reported", capturedAt: snapshot.capturedAt };
  return { state: "reported", capturedAt: snapshot.capturedAt, rows };
}
