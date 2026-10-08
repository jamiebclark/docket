// Where an activity row leads (research P15): Failures while the entry still needs a person, else the post, else the accounts page.

export interface ActivityLinkRow {
  kind: string;
  outcome: string;
  postId: string | null;
  postTargetId: string | null;
  postDeleted: boolean;
  /** The target's status now, if it still exists. */
  targetStatus: string | null;
}

export interface ActivityLink {
  href: string;
  label: string;
}

export function activityLink(row: ActivityLinkRow, projectSlug: string): ActivityLink | null {
  const base = `/p/${projectSlug}`;
  if (row.kind.startsWith("account_")) return { href: `${base}/accounts`, label: "Go to accounts" };
  if (!row.postTargetId) return null;
  const needsAttention = row.targetStatus === "failed" || row.targetStatus === "ambiguous";
  if (needsAttention && row.targetStatus === row.outcome) {
    return { href: `${base}/failures?target=${row.postTargetId}#target-${row.postTargetId}`, label: "Open in Failures" };
  }
  if (row.postId && !row.postDeleted) return { href: `${base}/posts/${row.postId}`, label: "Open post" };
  return null;
}
