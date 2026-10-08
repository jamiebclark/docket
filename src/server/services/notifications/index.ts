import { z } from "zod";
import { calloutCountText, unreadDisplay, unreadLabel } from "../../../lib/notifications/text";
import type { NotificationPanel, UnreadSummary } from "../../../lib/notifications/types";
import { ForbiddenError, NotFoundError } from "../../dal/errors";
import type { ProjectSetScope } from "../../dal/my-projects";
import { NotificationsBusyError } from "../../dal/notifications";
import type { ProjectScope } from "../../dal/scope";
import { toNotificationItem } from "./panel";
import type { ProblemsViewScope } from "./view-mark";

export type { UnreadSummary };

const PANEL_SIZE = 10;
const NOT_FOUND = "That project could not be found.";

const toggleSchema = z.object({ projectSlug: z.string().min(1), on: z.enum(["true", "false"]) });
const ownToggleSchema = z.object({ on: z.enum(["true", "false"]) });

function summaryOf(count: number): UnreadSummary {
  return { count, display: unreadDisplay(count), label: unreadLabel(count) };
}

/** Header and refresh. Callers resolve the session first; an empty set gives { 0, "", "No unread problems" }. */
export async function unreadSummary(set: ProjectSetScope): Promise<UnreadSummary> {
  if (set.projects.length === 0) return summaryOf(0);
  return summaryOf(await set.notifications.countUnread());
}

/** Panel model: state, up to 10 items (read and unread alike, notifications-on projects only) and the unread summary. */
export async function recentPanel(set: ProjectSetScope, _now: Date): Promise<NotificationPanel> {
  if (set.projects.length === 0) return { state: "no_projects", items: [], unread: summaryOf(0) };
  if (set.projects.every((p) => p.notifications?.muted === true)) return { state: "all_muted", items: [], unread: summaryOf(0) };
  const seen = new Map(set.projects.flatMap((p) => (p.notifications ? [[p.id, BigInt(p.notifications.seenSeq)] as const] : [])));
  const [records, count] = await Promise.all([set.notifications.recent(PANEL_SIZE), set.notifications.countUnread()]);
  return { state: "ok", items: records.map((r) => toNotificationItem(r, seen)), unread: summaryOf(count) };
}

/** Every project in the set, muted or not. Locks only projects with something newer; reports the ones it could not. */
export async function markAllRead(set: ProjectSetScope): Promise<{ marked: number; busy: string[] }> {
  const names = new Map(set.projects.map((p) => [p.id, p.name]));
  let marked = 0;
  const busy: string[] = [];
  for (const projectId of await set.notifications.projectsWithUnread()) {
    try {
      if ((await set.notifications.write(projectId, { markRead: true })) === "changed") marked += 1;
    } catch (error) {
      if (!(error instanceof NotificationsBusyError)) throw error;
      busy.push(names.get(projectId) ?? "A project");
    }
  }
  return { marked, busy };
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
  if (result === "not_member") throw new NotFoundError(NOT_FOUND);
  return { projectName: project.name, on: on === "true" };
}

/** The same from project settings, for the caller's own state. */
export async function setMyProjectNotifications(scope: ProjectScope, input: unknown): Promise<{ on: boolean }> {
  if (scope.actor.kind !== "member") throw new ForbiddenError();
  const { on } = ownToggleSchema.parse(input);
  const result = await scope.notifications.write({ markRead: on === "true", muted: on === "false" });
  if (result === "not_member") throw new NotFoundError(NOT_FOUND);
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
