import {
  ATTENTION_KINDS,
  anyKindOn,
  kindOn,
  offeredPlatforms,
  switchesToTurnAllOff,
  switchesToTurnAllOn,
  type ProjectPreferences,
  type SwitchAxis,
} from "../../../lib/notifications/eligibility";
import { calloutCountText, switchLabel, unreadDisplay, unreadLabel } from "../../../lib/notifications/text";
import type { NotificationPanel, UnreadSummary } from "../../../lib/notifications/types";
import { resolveSnooze, SNOOZE_CHOICES } from "../../../lib/notifications/snooze";
import { ForbiddenError, NotFoundError } from "../../dal/errors";
import type { ProjectSetScope } from "../../dal/my-projects";
import { NotificationsBusyError, type MarkOutcome } from "../../dal/notifications";
import type { ProjectScope } from "../../dal/scope";
import { platformName, platformOptions } from "../activity";
import { z } from "zod";
import { toNotificationItem } from "./panel";
import type { ProblemsViewScope } from "./view-mark";

export type { UnreadSummary };

const PANEL_SIZE = 10;

function summaryOf(count: number, nextChangeAt: Date | null = null): UnreadSummary {
  return { count, display: unreadDisplay(count), label: unreadLabel(count), nextChangeAt: nextChangeAt ? nextChangeAt.toISOString() : null };
}

export interface SwitchState {
  axis: SwitchAxis;
  key: string;
  /** "Failed", "Needs reconnecting", "Bluesky" — already resolved for display. */
  label: string;
  on: boolean;
}

export interface ProjectPreferenceRow {
  slug: string;
  name: string;
  /** The roll-up: any kind on (N33). */
  on: boolean;
  /** Always the four N1 kinds, in display order. */
  kinds: SwitchState[];
  /** The offered platforms only (N32, FR-019); empty for a project with no accounts and no off switch. */
  platforms: SwitchState[];
}

function kindsOf(preferences: ProjectPreferences): SwitchState[] {
  return ATTENTION_KINDS.map((outcome) => ({ axis: "kind", key: outcome, label: switchLabel("kind", outcome), on: kindOn(preferences, outcome) }));
}

/** The offered platforms only (N32, FR-019), in registry order. */
function platformsOf(preferences: ProjectPreferences, projectPlatformKeys: readonly string[]): SwitchState[] {
  return offeredPlatforms(preferences, projectPlatformKeys, platformOptions()).map((o) => ({
    axis: "platform",
    key: o.key,
    label: switchLabel("platform", o.key, platformName(o.key)),
    on: o.on,
  }));
}

/** The grid: one row per project the caller belongs to, ordered by project name. */
export async function myNotificationPreferences(set: ProjectSetScope): Promise<ProjectPreferenceRow[]> {
  const platformsByProject = await set.notifications.platformsByProject();
  return set.projects.map((p) => ({
    slug: p.slug,
    name: p.name,
    on: anyKindOn(p.preferences),
    kinds: kindsOf(p.preferences),
    platforms: platformsOf(p.preferences, platformsByProject.get(p.id) ?? []),
  }));
}

/** The same for one project, for its settings card. Throws ForbiddenError for an API-key actor. */
export async function myPreferencesForProject(scope: ProjectScope): Promise<ProjectPreferenceRow> {
  const [preferences, projectPlatformKeys] = await Promise.all([scope.notifications.preferences(), scope.accounts.platformKeys()]);
  return {
    slug: scope.project.slug,
    name: scope.project.name,
    on: anyKindOn(preferences),
    kinds: kindsOf(preferences),
    platforms: platformsOf(preferences, projectPlatformKeys),
  };
}

export interface SwitchChange {
  projectSlug: string;
  projectName: string;
  /** `project` is the roll-up control; otherwise the switch that changed. */
  axis: SwitchAxis | "project";
  /** Absent for `axis: "project"`. */
  key?: string;
  on: boolean;
  /** False when it was already in that state: nothing was written, and the page still confirms the state. */
  changed: boolean;
}

const switchShapeSchema = z.object({
  axis: z.enum(["kind", "platform", "project"]),
  key: z.string().min(1).max(40).optional(),
  on: z.enum(["true", "false"]),
});

const switchBySlugSchema = switchShapeSchema.extend({ projectSlug: z.string().min(1) });

interface ValidatedSwitch {
  axis: SwitchAxis | "project";
  key?: string;
  on: boolean;
}

function invalidSwitchKey(): never {
  throw new z.ZodError([{ code: "custom", path: ["key"], message: "invalid" }]);
}

/** The order of refusal's step 4: the shape is right, but the kind/platform key is not (Q21). */
function validateSwitchInput(
  parsed: { axis: "kind" | "platform" | "project"; key?: string; on: "true" | "false" },
  offeredPlatformKeys: readonly string[],
): ValidatedSwitch {
  const on = parsed.on === "true";
  if (parsed.axis === "project") {
    if (parsed.key !== undefined) invalidSwitchKey();
    return { axis: "project", on };
  }
  if (parsed.axis === "kind") {
    if (!parsed.key || !(ATTENTION_KINDS as readonly string[]).includes(parsed.key)) invalidSwitchKey();
    return { axis: "kind", key: parsed.key, on };
  }
  if (!parsed.key || !offeredPlatformKeys.includes(parsed.key)) invalidSwitchKey();
  return { axis: "platform", key: parsed.key, on };
}

/** `axis: "project"` resolves to the switch list the roll-up control submits (Q9, Q12). */
function switchesFor(
  validated: ValidatedSwitch,
  preferences: ProjectPreferences,
  offered: readonly { key: string; on: boolean }[],
): readonly { axis: SwitchAxis; key: string }[] {
  if (validated.axis === "project") return validated.on ? switchesToTurnAllOn(preferences, offered) : switchesToTurnAllOff();
  return [{ axis: validated.axis, key: validated.key! }];
}

function rawProjectSlug(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const value = (input as Record<string, unknown>).projectSlug;
  return typeof value === "string" ? value : undefined;
}

/**
 * From the Notifications page. A slug outside the caller's set is the same "not found" as an unknown
 * one; nothing is written or revealed in either case (Q21).
 */
export async function setSwitchBySlug(set: ProjectSetScope, input: unknown): Promise<SwitchChange> {
  const project = set.projects.find((p) => p.slug === rawProjectSlug(input));
  if (!project) throw new NotFoundError();
  const parsed = switchBySlugSchema.parse(input);
  const platformsByProject = await set.notifications.platformsByProject();
  const offered = platformsOf(project.preferences, platformsByProject.get(project.id) ?? []);
  const validated = validateSwitchInput(parsed, offered.map((o) => o.key));
  const switches = switchesFor(validated, project.preferences, offered);
  const outcome = await set.notifications.setSwitches(project.id, { switches, on: validated.on });
  if (outcome.outcome === "not_member") throw new ForbiddenError();
  return {
    projectSlug: project.slug,
    projectName: project.name,
    axis: validated.axis,
    key: validated.key,
    on: validated.on,
    changed: outcome.outcome === "changed",
  };
}

/** The same from a project's settings page, for the caller's own switches. Any member role may. */
export async function setMySwitchForProject(scope: ProjectScope, input: unknown): Promise<SwitchChange> {
  if (scope.actor.kind !== "member") throw new ForbiddenError();
  const parsed = switchShapeSchema.parse(input);
  const [preferences, platformKeys] = await Promise.all([scope.notifications.preferences(), scope.accounts.platformKeys()]);
  const offered = platformsOf(preferences, platformKeys);
  const validated = validateSwitchInput(parsed, offered.map((o) => o.key));
  const switches = switchesFor(validated, preferences, offered);
  const outcome = await scope.notifications.setSwitches({ switches, on: validated.on });
  if (outcome.outcome === "not_member") throw new ForbiddenError();
  return {
    projectSlug: scope.project.slug,
    projectName: scope.project.name,
    axis: validated.axis,
    key: validated.key,
    on: validated.on,
    changed: outcome.outcome === "changed",
  };
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
  if (set.projects.every((p) => !anyKindOn(p.preferences))) return { state: "all_muted", items: [], unread: summaryOf(0) };
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

/** Callout: 0 when the project's roll-up is off. */
export async function projectUnread(scope: ProjectScope): Promise<{ count: number; text: string }> {
  if (scope.actor.kind !== "member") throw new ForbiddenError();
  const count = await scope.notifications.unreadCount();
  return { count, text: count > 0 ? calloutCountText(count) : "" };
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
