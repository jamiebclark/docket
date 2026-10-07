import { and, eq } from "drizzle-orm";
import { roles, type PermissionRequest, type Role } from "../auth/access";
import { getDb, type Database } from "../db/client";
import { runCrossProject } from "../db/cross-project";
import { member, projects, type ApiKeyPermission } from "../db/schema";
import { createAccountsRepo, type AccountsRepo } from "./accounts";
import { createAttemptsRepo, type AttemptsRepo } from "./attempts";
import { createAuditRepo, type AuditRepo } from "./audit";
import { createConnectAttemptsRepo, type ConnectAttemptsRepo } from "./connect-attempts";
import {
  countRequest,
  createApiKeysRepo,
  findActiveKeyByHash,
  hashApiKey,
  isWellFormedApiKey,
  type ApiKeysRepo,
} from "./api-keys";
import { createIdempotencyRepo, type IdempotencyRepo } from "./idempotency";
import { createWebhooksRepo, type WebhooksRepo } from "./webhooks";
import { ForbiddenError, InvalidApiKeyError, NotFoundError } from "./errors";
import { createInvitationsRepo, type InvitationsRepo } from "./invitations";
import { createJobItemsRepo, createJobsRepo, type JobItemsRepo, type JobsRepo } from "./jobs";
import { createMediaRepo, type MediaRepo } from "./media";
import { createUploadsRepo, type UploadsRepo } from "./uploads";
import { createPostsRepo, type PostsRepo } from "./posts";
import { createSlotsRepo, type SlotsRepo } from "./slots";
import { createTargetsRepo, type TargetsRepo } from "./targets";
import { createTokensRepo, type TokensRepo } from "./tokens";
import { createMembersRepo, type MembersRepo } from "./members";
import { createGenerationFailuresRepo, type GenerationFailuresRepo } from "./generation-failures";
import { createSeriesRepo, type SeriesRepo } from "./series";
import { createVoiceProfilesRepo, createVoiceVersionsRepo, type VoiceProfilesRepo, type VoiceVersionsRepo } from "./voice";
import { getProject, setDefaultVoiceProfile, updateProject, type ProjectRecord, type ProjectSettingsPatch } from "./projects";

export type { Role, PermissionRequest };

/** Just what the DAL needs from a Better Auth session. */
export interface SessionLike {
  user: { id: string };
}

export type ApprovalPolicy = (typeof projects.$inferSelect)["defaultApprovalPolicy"];
export type SchedulingPolicy = (typeof projects.$inferSelect)["defaultSchedulingPolicy"];

/** Who is acting. Members and the job runner are the 007/008 actors; an API key is this entry's. */
export type ScopeActor =
  | { kind: "member" }
  | { kind: "job_runner" }
  | { kind: "api_key"; apiKeyId: string; name: string; permissions: readonly ApiKeyPermission[] };

/** What a key permission lets `can()` answer true for (contracts/services.md). */
// A permission that writes also sees what it wrote: the services read back, validate and check accounts, slots,
// images and voices, so a key holding only `write_posts` still works (decisions.md, 009 API key grants).
const SEES = {
  project: ["view"],
  account: ["view"],
  slot: ["view"],
  media: ["view"],
  post: ["view"],
  voice: ["view"],
} as const satisfies PermissionRequest;

const KEY_GRANTS: Record<ApiKeyPermission, PermissionRequest> = {
  read: {
    project: ["view"],
    member: ["view"],
    account: ["view"],
    slot: ["view"],
    media: ["view"],
    post: ["view"],
    voice: ["view"],
  },
  write_posts: { ...SEES, media: ["view", "edit"], post: ["view", "edit", "schedule"] },
  generate: { ...SEES, generation: ["run"], post: ["view", "edit"] },
  manage_jobs: { ...SEES, generation: ["run"], post: ["view", "edit"] },
  auto_approve: { generation: ["auto_approve"] },
};

function keyCan(permissions: readonly ApiKeyPermission[], request: PermissionRequest): boolean {
  const entries = Object.entries(request) as [string, readonly string[]][];
  return entries.every(([resource, actions]) =>
    actions.every((action) =>
      permissions.some((p) => {
        const granted = (KEY_GRANTS[p] as Record<string, readonly string[] | undefined>)[resource];
        return granted?.includes(action) ?? false;
      }),
    ),
  );
}

export interface ProjectScope {
  readonly actor: ScopeActor;
  readonly project: {
    id: string;
    slug: string;
    name: string;
    timezone: string;
    defaultApprovalPolicy: ApprovalPolicy;
    defaultSchedulingPolicy: SchedulingPolicy;
    defaultVoiceProfileId: string | null;
  };
  readonly membership: { memberId: string; userId: string; role: Role };
  can(request: PermissionRequest): boolean;
  // Repositories: every query filters by project.id (or organization_id = project.id).
  readonly audit: AuditRepo;
  readonly members: MembersRepo;
  readonly invitations: InvitationsRepo;
  readonly invitationTokens: TokensRepo;
  readonly accounts: AccountsRepo;
  readonly slots: SlotsRepo;
  readonly media: MediaRepo;
  readonly uploads: UploadsRepo;
  readonly posts: PostsRepo;
  readonly targets: TargetsRepo;
  readonly attempts: AttemptsRepo;
  readonly connectAttempts: ConnectAttemptsRepo;
  readonly voiceProfiles: VoiceProfilesRepo;
  readonly voiceVersions: VoiceVersionsRepo;
  readonly series: SeriesRepo;
  readonly generationFailures: GenerationFailuresRepo;
  readonly jobs: JobsRepo;
  readonly jobItems: JobItemsRepo;
  readonly apiKeys: ApiKeysRepo;
  readonly idempotency: IdempotencyRepo;
  readonly webhooks: WebhooksRepo;
  readonly projects: {
    get(): Promise<ProjectRecord | null>;
    setDefaultVoiceProfile(profileId: string | null): Promise<void>;
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
  defaultVoiceProfileId: projects.defaultVoiceProfileId,
};

/** Resolves the caller's membership of a project. `exec` is the database or a transaction. */
async function resolve(
  exec: Database,
  userId: string,
  where: ReturnType<typeof eq>,
): Promise<ScopeData> {
  const rows = await exec
    .select({ project: projectColumns, memberId: member.id, role: member.role })
    .from(projects)
    .innerJoin(member, and(eq(member.organizationId, projects.id), eq(member.userId, userId)))
    .where(where)
    .limit(1);
  const row = rows[0];
  if (!row || !(row.role in roles)) throw new NotFoundError();
  return {
    project: row.project,
    membership: { memberId: row.memberId, userId, role: row.role as Role },
  };
}

/** The scheduling repositories, shared with `forSchedulerProject` (pinned, no membership). */
export function createSchedulingRepos(exec: Database, projectId: string) {
  return {
    accounts: createAccountsRepo(exec, projectId),
    slots: createSlotsRepo(exec, projectId),
    media: createMediaRepo(exec, projectId),
    posts: createPostsRepo(exec, projectId),
    targets: createTargetsRepo(exec, projectId),
    attempts: createAttemptsRepo(exec, projectId),
    webhooks: createWebhooksRepo(exec, projectId),
  };
}

function buildScope(exec: Database, data: ScopeData, actor: ScopeActor = { kind: "member" }): ProjectScope {
  const scope: ProjectScope = {
    ...data,
    actor,
    can:
      actor.kind === "api_key"
        ? (request) => keyCan(actor.permissions, request)
        : (request) => roles[data.membership.role].authorize(request as never).success,
    audit: createAuditRepo(exec, data.project.id),
    members: createMembersRepo(exec, data.project.id),
    uploads: createUploadsRepo(exec, data.project.id),
    invitations: createInvitationsRepo(exec, data.project.id),
    invitationTokens: createTokensRepo(exec, data.project.id),
    connectAttempts: createConnectAttemptsRepo(exec, data.project.id),
    voiceProfiles: createVoiceProfilesRepo(exec, data.project.id),
    voiceVersions: createVoiceVersionsRepo(exec, data.project.id),
    series: createSeriesRepo(exec, data.project.id),
    generationFailures: createGenerationFailuresRepo(exec, data.project.id),
    jobs: createJobsRepo(exec, data.project.id),
    jobItems: createJobItemsRepo(exec, data.project.id),
    apiKeys: createApiKeysRepo(exec, data.project.id),
    idempotency: createIdempotencyRepo(exec, data.project.id),
    ...createSchedulingRepos(exec, data.project.id),
    projects: {
      get: () => getProject(data.project.id, exec),
      setDefaultVoiceProfile: (profileId) => setDefaultVoiceProfile(data.project.id, profileId, exec),
      update: (patch) => updateProject(data.project.id, patch, exec),
    },
    async transaction(fn, opts) {
      return getRoot(exec).transaction(async (tx) => {
        const txExec = tx as unknown as Database;
        const projectId = eq(projects.id, data.project.id);
        if (opts?.lockProject) {
          // The lock is its own statement: a membership read in the same statement would use the
          // snapshot taken before the lock was granted and miss a concurrent removal or demotion.
          await txExec.select({ id: projects.id }).from(projects).where(projectId).for("update");
        }
        if (actor.kind === "api_key") {
          // A revoked or expired key stops working mid-request: its own statement, like the lock above.
          const valid = await createApiKeysRepo(txExec, data.project.id).isValid(actor.apiKeyId);
          if (!valid) throw new InvalidApiKeyError();
          return fn(buildScope(txExec, data, actor));
        }
        // The job runner has no session: its membership is fixed, never re-resolved (research D11).
        const fresh = data.membership.memberId === JOB_RUNNER_MEMBER ? data : await resolve(txExec, data.membership.userId, projectId);
        return fn(buildScope(txExec, fresh, actor));
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
    resolve(db, session.user.id, eq(projects.slug, projectSlug)),
  );
  return buildScope(db, data);
}

const JOB_RUNNER_MEMBER = "job-runner";

/**
 * A scope pinned to one project with no session, for the generation-job runner (research D11). It can do
 * what an editor can (`generation: run`, `post: edit`) but not `generation: auto_approve`. Callers pass
 * `createdByUserId` explicitly; the runner never writes `membership.userId`.
 */
export async function forJobRunner(projectId: string, actorUserId: string | null): Promise<ProjectScope> {
  const db = getDb();
  const rows = await crossProject("scheduler: job runner project", () =>
    db.select(projectColumns).from(projects).where(eq(projects.id, projectId)).limit(1),
  );
  const project = rows[0];
  if (!project) throw new NotFoundError();
  return buildScope(
    db,
    { project, membership: { memberId: JOB_RUNNER_MEMBER, userId: actorUserId ?? "", role: "editor" } },
    { kind: "job_runner" },
  );
}

/**
 * Authenticates a raw API key and counts the request against its rate limit (research D4).
 * Throws InvalidApiKeyError for anything that is not an active key. The scope acts as an editor whose
 * `can()` is narrowed to the key's permissions.
 */
export async function forApiKey(
  rawKey: string,
): Promise<{ scope: ProjectScope; rate: { count: number; limit: number; resetAt: Date } }> {
  if (!isWellFormedApiKey(rawKey)) throw new InvalidApiKeyError();
  const db = getDb();
  const found = await crossProject("api: authenticate key", () => findActiveKeyByHash(db, hashApiKey(rawKey)));
  if (!found) throw new InvalidApiKeyError();
  const { key, project } = found;
  const rate = await countRequest(db, project.id, key.id);
  if (!rate) throw new InvalidApiKeyError();
  const scope = buildScope(
    db,
    { project, membership: { memberId: "api-key:" + key.id, userId: key.createdByUserId ?? "", role: "editor" } },
    { kind: "api_key", apiKeyId: key.id, name: key.name, permissions: key.permissions },
  );
  return { scope, rate };
}

type ActorScope = Pick<ProjectScope, "actor" | "membership">;

/** Who acted, as a user id (never `""`) and an API key id; each may be null. */
export function actorRefs(scope: ActorScope): { userId: string | null; apiKeyId: string | null } {
  return {
    userId: scope.membership.userId || null,
    apiKeyId: scope.actor.kind === "api_key" ? scope.actor.apiKeyId : null,
  };
}

/** Columns that record who made a row: the member, or the key (with the key's creator as the user). */
export function actorColumns(scope: ActorScope): {
  createdByUserId: string | null;
  createdByApiKeyId: string | null;
} {
  const { userId, apiKeyId } = actorRefs(scope);
  return { createdByUserId: userId, createdByApiKeyId: apiKeyId };
}

/** The attribution columns of a `publish_attempts` row written on behalf of the actor. */
export function attemptActor(scope: ActorScope): { actorUserId: string | null; actorApiKeyId: string | null } {
  const { userId, apiKeyId } = actorRefs(scope);
  return { actorUserId: userId, actorApiKeyId: apiKeyId };
}

/** The columns that record who resolved a target. */
export function resolverColumns(scope: ActorScope): {
  resolvedByUserId: string | null;
  resolvedByApiKeyId: string | null;
} {
  const { userId, apiKeyId } = actorRefs(scope);
  return { resolvedByUserId: userId, resolvedByApiKeyId: apiKeyId };
}

export function requireRole(scope: ProjectScope, ...allowed: Role[]): void {
  if (!allowed.includes(scope.membership.role)) throw new ForbiddenError();
}

export function requirePermission(scope: ProjectScope, request: PermissionRequest): void {
  if (!scope.can(request)) throw new ForbiddenError();
}

