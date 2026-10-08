// The serialisable shapes shared by the popover, /notifications and GET /api/me/notifications/recent. Types only.

export type NotificationOutcome = "failed" | "ambiguous" | "needs_reauth" | "connect_failed";

export interface NotificationItem {
  /** The activity event id. */
  id: string;
  outcome: NotificationOutcome;
  outcomeLabel: string;
  /** ISO 8601 UTC, whole milliseconds. */
  occurredAt: string;
  project: { slug: string; name: string; timeZone: string };
  /** One platform, or a connect group's several. */
  platforms: { key: string; name: string }[];
  /** "Removed account" when removed; null for a group connect failure. */
  accountName: string | null;
  postDeleted: boolean;
  /** The stored, already-scrubbed message. */
  message: string;
  /** Newer than the person's reading position for that project. */
  isNew: boolean;
  link: { href: string; label: string } | null;
}

export interface UnreadSummary {
  count: number;
  display: string;
  label: string;
}

export interface NotificationPanel {
  state: "ok" | "all_muted" | "no_projects";
  /** Up to 10, newest first; empty unless `state` is "ok". */
  items: NotificationItem[];
  unread: UnreadSummary;
}
