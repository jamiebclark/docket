import { and, eq } from "drizzle-orm";
import { roles, type PermissionRequest, type Role } from "../auth/access";
import { getDb, type Database } from "../db/client";
import { runCrossProject } from "../db/cross-project";
import { member, projects } from "../db/schema";
import { createAuditRepo, type AuditRepo } from "./audit";
import { ForbiddenError, NotFoundError } from "./errors";
import { createInvitationsRepo, type InvitationsRepo } from "./invitations";
import { createTokensRepo, type TokensRepo } from "./tokens";
import { createMembersRepo, type MembersRepo } from "./members";
import { getProject, updateProject, type ProjectRecord, type ProjectSettingsPatch } from "./projects";

export type { Role, PermissionRequest };

/** Just what the DAL needs from a Better Auth session. */
export interface SessionLike {
  user: { id: string };
}

export type ApprovalPolicy = (typeof projects.$inferSelect)["defaultApprovalPolicy"];
export type SchedulingPolicy = (typeof projects.$inferSelect)["defaultSchedulingPolicy"];

export interface ProjectScope {
  readonly project: {
    id: string;
    slug: string;
    name: string;
    timezone: string;
    defaultApprovalPolicy: ApprovalPolicy;
    defaultSchedulingPolicy: SchedulingPolicy;
  };
  readonly membership: { memberId: string; userId: string; role: Role };
  can(request: PermissionRequest): boolean;
  // Repositories: every query filters by project.id (or organization_id = project.id).
  readonly audit: AuditRepo;
  readonly members: MembersRepo;
  readonly invitations: InvitationsRepo;
  readonly invitationTokens: TokensRepo;
  readonly projects: {
    get(): Promise<ProjectRecord | null>;
    update(patch: ProjectSettingsPatch): Promise<ProjectRecord>;
  };
  transaction<T>(fn: (tx: ProjectScope) => Promise<T>, opts?: { lockProject?: boolean }): Promise<T>;
}

/** The only way to run a query that is not pinned to one project. */
export function crossProject<T>(reason: string, fn: () => Promise<T>): Promise<T> {
  return runCrossProject(reason, fn);
}

type ScopeData = Pick<ProjectScope, "project" | "membership">;

const projectColumns = {
  id: projects.id,
  slug: projects.slug,
  name: projects.name,
  timezone: projects.timezone,
  defaultApprovalPolicy: projects.defaultApprovalPolicy,
  defaultSchedulingPolicy: projects.defaultSchedulingPolicy,
};

/** Resolves the caller's membership of a project. `exec` is the database or a transaction. */
async function resolve(
  exec: Database,
  userId: string,
  where: ReturnType<typeof eq>,
  lock: boolean,
): Promise<ScopeData> {
  const query = exec
    .select({ project: projectColumns, memberId: member.id, role: member.role })
    .from(projects)
    .innerJoin(member, and(eq(member.organizationId, projects.id), eq(member.userId, userId)))
    .where(where)
    .limit(1);
  const rows = await (lock ? query.for("update", { of: projects }) : query);
  const row = rows[0];
  if (!row || !(row.role in roles)) throw new NotFoundError();
  return {
    project: row.project,
    membership: { memberId: row.memberId, userId, role: row.role as Role },
  };
}

function buildScope(exec: Database, data: ScopeData): ProjectScope {
  const scope: ProjectScope = {
    ...data,
    can: (request) => roles[data.membership.role].authorize(request as never).success,
    audit: createAuditRepo(exec, data.project.id),
    members: createMembersRepo(exec, data.project.id),
    invitations: createInvitationsRepo(exec, data.project.id),
    invitationTokens: createTokensRepo(exec, data.project.id),
    projects: {
      get: () => getProject(data.project.id, exec),
      update: (patch) => updateProject(data.project.id, patch, exec),
    },
    async transaction(fn, opts) {
      return getRoot(exec).transaction(async (tx) => {
        const txExec = tx as unknown as Database;
        const fresh = opts?.lockProject
          ? // Lock the project row, then re-check membership so a member removed concurrently can't act.
            await resolve(txExec, data.membership.userId, eq(projects.id, data.project.id), true)
          : await resolve(txExec, data.membership.userId, eq(projects.id, data.project.id), false);
        return fn(buildScope(txExec, fresh));
      });
    },
  };
  return scope;
}

// A transaction handle has no nested `transaction` of its own that we want: reuse the real database.
function getRoot(exec: Database): Database {
  return "transaction" in exec ? exec : getDb();
}

/**
 * Resolves membership and role for this call; never cached across requests.
 * Throws NotFoundError for no session, an unknown slug or a non-member (never reveals which).
 */
export async function forProject(session: SessionLike | null, projectSlug: string): Promise<ProjectScope> {
  if (!session) throw new NotFoundError();
  const db = getDb();
  const data = await crossProject("resolve project", () =>
    resolve(db, session.user.id, eq(projects.slug, projectSlug), false),
  );
  return buildScope(db, data);
}

export function requireRole(scope: ProjectScope, ...allowed: Role[]): void {
  if (!allowed.includes(scope.membership.role)) throw new ForbiddenError();
}

export function requirePermission(scope: ProjectScope, request: PermissionRequest): void {
  if (!scope.can(request)) throw new ForbiddenError();
}

