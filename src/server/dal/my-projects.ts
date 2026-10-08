import { eq } from "drizzle-orm";
import { roles, type Role } from "../auth/access";
import { getDb } from "../db/client";
import { runForProjectSet } from "../db/cross-project";
import { member, projects } from "../db/schema";
import { createActivityReader, type ActivityRepo } from "./activity";
import { createApiKeysRepo } from "./api-keys";
import { NotFoundError } from "./errors";
import { createMembersRepo } from "./members";
import { crossProject, type SessionLike } from "./scope";

export interface MyProject {
  id: string;
  slug: string;
  name: string;
  timeZone: string;
  role: Role;
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
      })
      .from(member)
      .innerJoin(projects, eq(projects.id, member.organizationId))
      .where(eq(member.userId, userId))
      .orderBy(projects.name),
  );
  const mine: MyProject[] = rows.flatMap((r) => {
    const role = r.role as Role;
    return role in roles && roles[role].authorize({ post: ["view"] }).success ? [{ ...r, role }] : [];
  });
  const projectIds = mine.map((p) => p.id);
  const reader = createActivityReader(db, projectIds, { memberUserId: userId });
  const inSet = <T>(fn: () => Promise<T>) => runForProjectSet({ reason: REASON, projectIds }, fn);
  const allowed = new Set(projectIds);
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
