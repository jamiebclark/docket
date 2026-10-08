import { and, eq } from "drizzle-orm";
import { roles, type Role } from "../auth/access";
import { getDb } from "../db/client";
import { runForProjectSet } from "../db/cross-project";
import { member, notificationStates, projects } from "../db/schema";
import { createActivityReader, type ActivityRecord, type ActivityRepo } from "./activity";
import { createApiKeysRepo } from "./api-keys";
import { NotFoundError } from "./errors";
import { createMembersRepo } from "./members";
import { createNotificationsRepo, createNotificationsSetReader } from "./notifications";
import { crossProject, type SessionLike } from "./scope";

export interface MyProject {
  id: string;
  slug: string;
  name: string;
  timeZone: string;
  role: Role;
  /** The caller's own state for this project; null when there is no row (treated as notifications on). */
  notifications: { muted: boolean; seenSeq: string } | null;
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
    /** Unread attention events over the projects with notifications on, capped at 100. */
    countUnread(): Promise<number>;
    /** The newest attention events over the projects with notifications on. */
    recent(limit: number): Promise<ActivityRecord[]>;
    /** Projects (muted or not) with something newer than the position: the ones worth locking. */
    projectsWithUnread(): Promise<string[]>;
    /** One locked transaction for one project; an id outside the set throws NotFoundError before any SQL. */
    write(projectId: string, change: { markRead: boolean; muted?: boolean }): Promise<"changed" | "unchanged" | "not_member">;
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
        muted: notificationStates.muted,
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
  const mine: MyProject[] = rows.flatMap((r) => {
    const role = r.role as Role;
    if (!(role in roles && roles[role].authorize({ post: ["view"] }).success)) return [];
    const { muted, seenSeq, ...rest } = r;
    return [{ ...rest, role, notifications: muted === null || seenSeq === null ? null : { muted, seenSeq: seenSeq.toString() } }];
  });
  const projectIds = mine.map((p) => p.id);
  const reader = createActivityReader(db, projectIds, { memberUserId: userId });
  const inSet = <T>(fn: () => Promise<T>) => runForProjectSet({ reason: REASON, projectIds }, fn);
  const allowed = new Set(projectIds);
  // Muted projects are left out of the count and the panel; the SQL re-checks the mute itself.
  const unmutedIds = mine.filter((p) => p.notifications?.muted === false || p.notifications === null).map((p) => p.id);
  const unmutedReader = createActivityReader(db, unmutedIds, { memberUserId: userId });
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
      countUnread: () => inSet(() => createNotificationsSetReader(db, unmutedIds, userId).countUnread()),
      recent: (limit) => inSet(() => unmutedReader.listAttention({ projectIds: unmutedIds, userId, limit })),
      projectsWithUnread: () => inSet(() => createNotificationsSetReader(db, projectIds, userId).projectsWithUnread()),
      async write(projectId, change) {
        check(projectId);
        return inSet(() => createNotificationsRepo(db, projectId, userId).write(change));
      },
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
