import { Badge, type BadgeTone } from "./Badge";

type Tone = BadgeTone;

const STATUSES: Record<string, { label: string; tone: Tone }> = {
  draft: { label: "Draft", tone: "neutral" },
  needs_review: { label: "Needs review", tone: "warning" },
  approved: { label: "Approved", tone: "info" },
  scheduled: { label: "Scheduled", tone: "brand" },
  publishing: { label: "Publishing", tone: "info" },
  published: { label: "Published", tone: "success" },
  partially_failed: { label: "Partly failed", tone: "danger" },
  failed: { label: "Failed", tone: "danger" },
  rejected: { label: "Rejected", tone: "neutral" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  ambiguous: { label: "Needs your decision", tone: "warning" },
  needs_decision: { label: "Needs your decision", tone: "warning" },
  active: { label: "Connected", tone: "success" },
  needs_reauth: { label: "Needs reconnecting", tone: "danger" },
  queued: { label: "Queued", tone: "neutral" },
  running: { label: "Running", tone: "info" },
  done: { label: "Done", tone: "success" },
  completed: { label: "Completed", tone: "success" },
  completed_with_failures: { label: "Completed with failures", tone: "warning" },
};

/** Human label for a post, target or account status; unknown values read as their raw name. */
export function statusLabel(status: string): string {
  return STATUSES[status]?.label ?? status.replaceAll("_", " ");
}

/** Post, target or account status as text plus colour (never colour alone). */
export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUSES[status]?.tone ?? "neutral"}>{statusLabel(status)}</Badge>;
}
