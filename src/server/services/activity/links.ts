// Where an activity row leads (research P15): Failures while the entry still needs a person, else the
// post, else the Inbox for an engagement row, else the accounts page.

export interface ActivityLinkRow {
  kind: string;
  outcome: string;
  postId: string | null;
  postTargetId: string | null;
  postDeleted: boolean;
  /** The target's status now, if it still exists. */
  targetStatus: string | null;
  /** The account the row is about, where it has one; an engagement row always does. */
  socialAccountId: string | null;
}

export interface ActivityLink {
  href: string;
  label: string;
}

export function activityLink(row: ActivityLinkRow, projectSlug: string): ActivityLink | null {
  const base = `/p/${projectSlug}`;
  if (row.kind.startsWith("account_")) return { href: `${base}/accounts`, label: "Go to accounts" };
  // An engagement row has no post target of its own — the item it describes lives in the Inbox, and
  // before this it was the one attention row that led nowhere at all (020 feedback). Filtered to the
  // account that received it and to what is still waiting, which is what the row is telling you about.
  if (row.kind.startsWith("engagement_")) {
    const account = row.socialAccountId ? `&account=${row.socialAccountId}` : "";
    return { href: `${base}/inbox?state=waiting${account}`, label: "Open the Inbox" };
  }
  if (!row.postTargetId) return null;
  const needsAttention = row.targetStatus === "failed" || row.targetStatus === "ambiguous";
  if (needsAttention && row.targetStatus === row.outcome) {
    return { href: `${base}/failures?target=${row.postTargetId}#target-${row.postTargetId}`, label: "Open in Failures" };
  }
  if (row.postId && !row.postDeleted) return { href: `${base}/posts/${row.postId}`, label: "Open post" };
  return null;
}
