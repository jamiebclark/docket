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
  /** Newer than the person's reading position for that project, and not individually read. */
  isNew: boolean;
  /**
   * At or below the person's reading position: already read, so "Mark read" and "Snooze" would write
   * nothing (`markEvent` returns `unchanged` on exactly this condition). The row says "Read" instead
   * of offering two controls that do nothing. Distinct from `!isNew`, which is also false for a
   * snoozed event and for a project with no reading position yet — both still markable.
   */
  read: boolean;
  /** False for every row of a project that has reached the per-person mark cap (FR-023). */
  actionsAvailable: boolean;
  link: { href: string; label: string } | null;
}

export interface UnreadSummary {
  count: number;
  display: string;
  label: string;
  /** ISO 8601 UTC, the soonest live snooze over notifications-on projects, or null (M17). */
  nextChangeAt: string | null;
}

export interface NotificationPanel {
  /** `all_muted` is the roll-up: no project of the caller's has any kind on (N33); the wire value is unchanged from the old mute flag. */
  state: "ok" | "all_muted" | "no_projects";
  /** Up to 10, newest first; empty unless `state` is "ok". */
  items: NotificationItem[];
  unread: UnreadSummary;
}
