import { and, eq } from "drizzle-orm";
import { roles, type Role } from "../auth/access";
import { getDb } from "../db/client";
import { runForProjectSet } from "../db/cross-project";
import { member, notificationStates, projects } from "../db/schema";
import { anyKindOn, compileEligibility, preferencesOf, type ProjectPreferences, type SwitchAxis } from "../../lib/notifications/eligibility";
import { createActivityReader, type ActivityRepo, type AttentionRecord } from "./activity";
import { createApiKeysRepo } from "./api-keys";
import { NotFoundError } from "./errors";
import { createMembersRepo } from "./members";
import { createNotificationsRepo, createNotificationsSetReader, type MarkOutcome, type SwitchWriteOutcome, type WriteOutcome } from "./notifications";
import { crossProject, type SessionLike } from "./scope";

export interface MyProject {
  id: string;
  slug: string;
  name: string;
  timeZone: string;
  role: Role;
  /** The caller's floor for this project; null when there is no row. */
  notifications: { seenSeq: string } | null;
  /** The caller's compiled switches for this project. Empty maps mean everything is on (N27). */
  preferences: ProjectPreferences;
}

/** The caller's current projects and what may be read across them: the only cross-project reader (research P11). */
export interface ProjectSetScope {
  readonly userId: string;
  /** Current memberships whose role can `post: view`, by name. */
  readonly projects: readonly MyProject[];
  /** Every window must name one of `projects`; each statement joins `member` for the caller. */
  readonly activity: Pick<ActivityRepo, "list" | "summary">;
  /** Names of one project's members, for actor labels. */
  memberNames(projectId: string): Promise<Map<string, string>>;
  apiKeyName(projectId: string, keyId: string): Promise<string | null>;
  /** Problem notifications over the set (022). Every statement runs in the project-set section. */
  readonly notifications: {
    /** Unread attention events over the projects with any kind on, capped at 100. */
    countUnread(): Promise<number>;
    /** The newest attention events over the projects with any kind on. */
    recent(limit: number): Promise<AttentionRecord[]>;
    /** Projects with something newer than the position, whatever their switches: the ones worth locking. */
    projectsWithUnread(): Promise<string[]>;
    /** This person's switches, by project (data-model.md §4.1, Q16). */
    preferencesByProject(): Promise<Map<string, ProjectPreferences>>;
    /** Live-account platforms, by project (data-model.md §4.9, Q17). */
    platformsByProject(): Promise<Map<string, string[]>>;
    /** One locked transaction for one project; an id outside the set throws NotFoundError before any SQL. */
    write(projectId: string, change: { markRead: boolean }): Promise<WriteOutcome>;
    /** One locked transaction for one project; an id outside the set throws NotFoundError before any SQL. */
    setSwitches(projectId: string, input: { switches: readonly { axis: SwitchAxis; key: string }[]; on: boolean }): Promise<SwitchWriteOutcome>;
    /** The caller's attention event with this id, in one of their own projects, or null (N23, M11). */
    resolveAttentionEvent(eventId: string): Promise<{ projectId: string; seq: bigint } | null>;
    /** One row action. A projectId outside the set throws NotFoundError before any SQL, as `write` does. */
    markEvent(projectId: string, input: { eventId: string; countsAgainAt: Date | "never" }): Promise<MarkOutcome>;
    /** Over every project in the set, whatever its switches (FR-020). */
    markCounts(): Promise<Map<string, number>>;
    /** Over the projects with any kind on (FR-021). */
    nextChangeAt(): Promise<Date | null>;
  };
}

const REASON = "activity: my projects";

/** Resolves on every call, never cached. No session throws NotFoundError; no projects is an empty set. */
export async function forMyProjects(session: SessionLike | null): Promise<ProjectSetScope> {
  if (!session) throw new NotFoundError();
  const userId = session.user.id;
  const db = getDb();
  const rows = await crossProject("resolve my projects", async () =>
    db
      .select({
        id: projects.id,
        slug: projects.slug,
        name: projects.name,
        timeZone: projects.timezone,
        role: member.role,
        seenSeq: notificationStates.seenSeq,
      })
      .from(member)
      .innerJoin(projects, eq(projects.id, member.organizationId))
      .leftJoin(
        notificationStates,
        and(eq(notificationStates.projectId, member.organizationId), eq(notificationStates.userId, member.userId)),
      )
      .where(eq(member.userId, userId))
      .orderBy(projects.name),
  );
  const base = rows.flatMap((r) => {
    const role = r.role as Role;
    if (!(role in roles && roles[role].authorize({ post: ["view"] }).success)) return [];
    return [{ id: r.id, slug: r.slug, name: r.name, timeZone: r.timeZone, role, seenSeq: r.seenSeq }];
  });
  const projectIds = base.map((p) => p.id);
  const reader = createActivityReader(db, projectIds, { memberUserId: userId });
  const inSet = <T>(fn: () => Promise<T>) => runForProjectSet({ reason: REASON, projectIds }, fn);
  const allowed = new Set(projectIds);
  const setReader = createNotificationsSetReader(db, projectIds, userId);
  const prefsByProject =
    projectIds.length > 0 ? await inSet(() => setReader.preferencesByProject()) : new Map<string, ProjectPreferences>();
  const mine: MyProject[] = base.map((p) => ({
    id: p.id,
    slug: p.slug,
    name: p.name,
    timeZone: p.timeZone,
    role: p.role,
    notifications: p.seenSeq === null ? null : { seenSeq: p.seenSeq.toString() },
    preferences: prefsByProject.get(p.id) ?? preferencesOf([]),
  }));
  // A project with no kind on is left out of the count and the panel; the SQL re-checks the switches itself.
  const notifyingIds = mine.filter((p) => anyKindOn(p.preferences)).map((p) => p.id);
  const notifyingReader = createActivityReader(db, notifyingIds, { memberUserId: userId });
  const notifyingSetReader = createNotificationsSetReader(db, notifyingIds, userId);
  const notifyingPlans = new Map(notifyingIds.map((id) => [id, compileEligibility(prefsByProject.get(id) ?? preferencesOf([]))]));
  const check = (projectId: string) => {
    if (!allowed.has(projectId)) throw new NotFoundError();
  };

  return {
    userId,
    projects: mine,
    activity: {
      list: (q) => inSet(() => reader.list(q)),
      summary: (q) => inSet(() => reader.summary(q)),
    },
    notifications: {
      countUnread: () => inSet(() => notifyingSetReader.countUnread()),
      recent: (limit) => inSet(() => notifyingReader.listAttention({ projectIds: notifyingIds, userId, limit, plans: notifyingPlans })),
      projectsWithUnread: () => inSet(() => setReader.projectsWithUnread()),
      preferencesByProject: () => inSet(() => setReader.preferencesByProject()),
      platformsByProject: () => inSet(() => setReader.platformsByProject()),
      async write(projectId, change) {
        check(projectId);
        return inSet(() => createNotificationsRepo(db, projectId, userId).write(change));
      },
      async setSwitches(projectId, input) {
        check(projectId);
        return inSet(() => createNotificationsRepo(db, projectId, userId).setSwitches(input));
      },
      resolveAttentionEvent: (eventId) => inSet(() => setReader.resolveAttentionEvent(eventId)),
      async markEvent(projectId, input) {
        check(projectId);
        return inSet(() => createNotificationsRepo(db, projectId, userId).markEvent(input));
      },
      markCounts: () => inSet(() => setReader.markCounts()),
      nextChangeAt: () => inSet(() => notifyingSetReader.nextChangeAt()),
    },
    async memberNames(projectId) {
      check(projectId);
      return inSet(async () => new Map((await createMembersRepo(db, projectId).list()).map((m) => [m.userId, m.name])));
    },
    async apiKeyName(projectId, keyId) {
      check(projectId);
      return inSet(async () => (await createApiKeysRepo(db, projectId).get(keyId))?.name ?? null);
    },
  };
}
