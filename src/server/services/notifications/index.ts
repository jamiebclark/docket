import { z } from "zod";
import { calloutCountText, unreadDisplay, unreadLabel } from "../../../lib/notifications/text";
import type { NotificationPanel, UnreadSummary } from "../../../lib/notifications/types";
import { resolveSnooze, SNOOZE_CHOICES } from "../../../lib/notifications/snooze";
import { ForbiddenError, NotFoundError } from "../../dal/errors";
import type { ProjectSetScope } from "../../dal/my-projects";
import { NotificationsBusyError, type MarkOutcome } from "../../dal/notifications";
import type { ProjectScope } from "../../dal/scope";
import { toNotificationItem } from "./panel";
import type { ProblemsViewScope } from "./view-mark";

export type { UnreadSummary };

const PANEL_SIZE = 10;
const NOT_FOUND = "That project could not be found.";

const toggleSchema = z.object({ projectSlug: z.string().min(1), on: z.enum(["true", "false"]) });
const ownToggleSchema = z.object({ on: z.enum(["true", "false"]) });

function summaryOf(count: number, nextChangeAt: Date | null = null): UnreadSummary {
  return { count, display: unreadDisplay(count), label: unreadLabel(count), nextChangeAt: nextChangeAt ? nextChangeAt.toISOString() : null };
}

/** Header and refresh. Callers resolve the session first; an empty set gives { 0, "", "No unread problems", null }. */
export async function unreadSummary(set: ProjectSetScope): Promise<UnreadSummary> {
  if (set.projects.length === 0) return summaryOf(0);
  const [count, nextChangeAt] = await Promise.all([set.notifications.countUnread(), set.notifications.nextChangeAt()]);
  return summaryOf(count, nextChangeAt);
}

/** Panel model: state, up to 10 items (read and unread alike, notifications-on projects only) and the unread summary. */
export async function recentPanel(set: ProjectSetScope, _now: Date): Promise<NotificationPanel> {
  if (set.projects.length === 0) return { state: "no_projects", items: [], unread: summaryOf(0) };
  if (set.projects.every((p) => p.notifications?.muted === true)) return { state: "all_muted", items: [], unread: summaryOf(0) };
  const seen = new Map(set.projects.flatMap((p) => (p.notifications ? [[p.id, BigInt(p.notifications.seenSeq)] as const] : [])));
  const [records, count, nextChangeAt, markCounts] = await Promise.all([
    set.notifications.recent(PANEL_SIZE),
    set.notifications.countUnread(),
    set.notifications.nextChangeAt(),
    set.notifications.markCounts(),
  ]);
  return { state: "ok", items: records.map((r) => toNotificationItem(r, seen, markCounts)), unread: summaryOf(count, nextChangeAt) };
}

/** Every project in the set, muted or not. Locks only projects with something newer; reports the ones it could not. */
export async function markAllRead(set: ProjectSetScope): Promise<{ marked: number; busy: string[]; snoozesCleared: number }> {
  const names = new Map(set.projects.map((p) => [p.id, p.name]));
  let marked = 0;
  let snoozesCleared = 0;
  const busy: string[] = [];
  for (const projectId of await set.notifications.projectsWithUnread()) {
    try {
      const result = await set.notifications.write(projectId, { markRead: true });
      if (result.outcome === "changed") marked += 1;
      snoozesCleared += result.snoozesCleared;
    } catch (error) {
      if (!(error instanceof NotificationsBusyError)) throw error;
      busy.push(names.get(projectId) ?? "A project");
    }
  }
  return { marked, busy, snoozesCleared };
}

/** Viewing the problems list marks those projects read. Unknown slugs mark nothing; a busy lock leaves the count. */
export async function markProblemsView(set: ProjectSetScope, scope: ProblemsViewScope): Promise<void> {
  const wanted =
    scope.kind === "project"
      ? set.projects.filter((p) => p.slug === scope.slug)
      : scope.slugs
        ? set.projects.filter((p) => scope.slugs!.includes(p.slug))
        : set.projects;
  for (const p of wanted) {
    try {
      await set.notifications.write(p.id, { markRead: true });
    } catch (error) {
      if (!(error instanceof NotificationsBusyError)) throw error;
    }
  }
}

/** From the Notifications page. `on` = true also marks read. A slug outside the set is the same "not found" as an unknown one. */
export async function setNotificationsBySlug(set: ProjectSetScope, input: unknown): Promise<{ projectName: string; on: boolean }> {
  const { projectSlug, on } = toggleSchema.parse(input);
  const project = set.projects.find((p) => p.slug === projectSlug);
  if (!project) throw new NotFoundError(NOT_FOUND);
  const result = await set.notifications.write(project.id, { markRead: on === "true", muted: on === "false" });
  if (result.outcome === "not_member") throw new NotFoundError(NOT_FOUND);
  return { projectName: project.name, on: on === "true" };
}

/** The same from project settings, for the caller's own state. */
export async function setMyProjectNotifications(scope: ProjectScope, input: unknown): Promise<{ on: boolean }> {
  if (scope.actor.kind !== "member") throw new ForbiddenError();
  const { on } = ownToggleSchema.parse(input);
  const result = await scope.notifications.write({ markRead: on === "true", muted: on === "false" });
  if (result.outcome === "not_member") throw new NotFoundError(NOT_FOUND);
  return { on: on === "true" };
}

/** Callout: 0 when muted. */
export async function projectUnread(scope: ProjectScope): Promise<{ count: number; text: string }> {
  if (scope.actor.kind !== "member") throw new ForbiddenError();
  const count = await scope.notifications.unreadCount();
  return { count, text: count > 0 ? calloutCountText(count) : "" };
}

/** Settings card and Notifications page list. A project with no state row counts as on. */
export async function myProjectStates(set: ProjectSetScope): Promise<{ slug: string; name: string; on: boolean }[]> {
  return set.projects.map((p) => ({ slug: p.slug, name: p.name, on: p.notifications?.muted !== true }));
}

export async function myStateForProject(scope: ProjectScope): Promise<{ on: boolean }> {
  if (scope.actor.kind !== "member") throw new ForbiddenError();
  const row = await scope.notifications.get();
  return { on: row ? !row.muted : true };
}

/** The project holds EVENT_MARK_CAP marks for this person: nothing was written (FR-007). */
export class NotificationMarkCapError extends Error {
  constructor(message = "Per-problem actions are unavailable for this project until it is marked read.") {
    super(message);
    this.name = "NotificationMarkCapError";
  }
}

const markEventSchema = z.object({ eventId: z.string().uuid() });

export interface RowActionResult {
  eventId: string;
  projectName: string;
  /** For the no-JavaScript redirect's `?snoozed=<slug>` parameter (contracts/services.md §9). */
  projectSlug: string;
  /** The instant it comes back, for a snooze; null for "Mark read". */
  until: Date | null;
  /** The project's zone, for the confirmation's wording (FR-016). */
  timeZone: string;
  /** The caller's summary after the change, so the bell updates without a second round trip. */
  unread: UnreadSummary;
  /** True when the floor is already at or past the event: nothing was written, nothing is announced (M10). */
  noop: boolean;
}

async function rowActionResult(set: ProjectSetScope, projectId: string, eventId: string, outcome: MarkOutcome, until: Date | null): Promise<RowActionResult> {
  if (outcome.kind === "not_found") throw new NotFoundError();
  if (outcome.kind === "at_cap") throw new NotificationMarkCapError();
  if (outcome.kind === "not_member") throw new ForbiddenError();
  const project = set.projects.find((p) => p.id === projectId);
  const unread = await unreadSummary(set);
  return {
    eventId,
    projectName: project?.name ?? "",
    projectSlug: project?.slug ?? "",
    until,
    timeZone: project?.timeZone ?? "UTC",
    unread,
    noop: outcome.kind === "unchanged",
  };
}

/**
 * "Mark read" on one problem. Validates `{ eventId }` with Zod, resolves the project inside the caller's
 * set, writes the mark, then recomputes the summary.
 * Throws NotFoundError for an unknown, foreign or non-attention id (one answer for all three, N23),
 * NotificationMarkCapError at the cap, NotificationsBusyError on a busy lock.
 */
export async function markEventRead(set: ProjectSetScope, input: unknown): Promise<RowActionResult> {
  const { eventId } = markEventSchema.parse(input);
  const resolved = await set.notifications.resolveAttentionEvent(eventId);
  if (!resolved) throw new NotFoundError();
  const outcome = await set.notifications.markEvent(resolved.projectId, { eventId, countsAgainAt: "never" });
  return rowActionResult(set, resolved.projectId, eventId, outcome, null);
}

const snoozeEventSchema = z.object({ eventId: z.string().uuid(), choice: z.enum(SNOOZE_CHOICES) });

/**
 * "Snooze" on one problem. Validates `{ eventId, choice }`, resolves the project (and so its time zone),
 * resolves the choice to an absolute instant with `resolveSnooze` (N17) and writes it. Same errors as
 * `markEventRead`.
 */
export async function snoozeEvent(set: ProjectSetScope, input: unknown): Promise<RowActionResult> {
  const { eventId, choice } = snoozeEventSchema.parse(input);
  const resolved = await set.notifications.resolveAttentionEvent(eventId);
  if (!resolved) throw new NotFoundError();
  const project = set.projects.find((p) => p.id === resolved.projectId);
  const until = resolveSnooze(choice, new Date(), project?.timeZone ?? "UTC");
  const outcome = await set.notifications.markEvent(resolved.projectId, { eventId, countsAgainAt: until });
  return rowActionResult(set, resolved.projectId, eventId, outcome, until);
}
