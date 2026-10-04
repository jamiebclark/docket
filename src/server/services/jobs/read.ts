// jobs/read: list jobs, one job, and a job's items (contracts/services.md § Read).
import { z } from "zod";
import { getEnv } from "../../env";
import { NotFoundError } from "../../dal/errors";
import type { JobCounts, JobItemRecord, JobRecord, JobStatus, JobItemStatus } from "../../dal/jobs";
import type { ApprovalPolicy, ProjectScope, SchedulingPolicy } from "../../dal/scope";
import { getLlmStatus } from "../../llm";
import { schedulerConfig } from "../../scheduler/config";
import { toView } from "../media";
import { need } from "../generation/single";
import { JOB_MIN_CALL_MS, JOB_PERSIST_RESERVE_MS } from "../../scheduler/config";

export const JOBS_PAGE_SIZE = 50;
export const JOB_ITEMS_PAGE_SIZE = 100;

export type { JobCounts };
export type ItemErrorKind = NonNullable<JobItemRecord["lastErrorKind"]>;

export interface JobListItem {
  id: string;
  sourceKind: string;
  sourceSummary: string;
  createdBy: { id: string; name: string } | null;
  /** The API key that created the job, when a key did ("Deleted key" once it is gone). */
  createdByKey: { id: string; name: string } | null;
  createdAt: Date;
  startedAt: Date | null;
  itemCount: number;
  approval: ApprovalPolicy;
  scheduling: SchedulingPolicy;
  /** Auto-approved and queued without a human look (FR-011 warning). */
  unreviewedQueue: boolean;
  status: JobStatus;
  /** Still accepting items from the API. */
  open: boolean;
  counts: JobCounts;
  finishedAt: Date | null;
  cancelledAt: Date | null;
}

const pageSchema = z.object({
  page: z.number().int().min(1).max(10_000).optional(),
  /** Paging by offset for callers that do not use page numbers (the API). Wins over `page`. */
  limit: z.number().int().min(1).max(500).optional(),
  offset: z.number().int().min(0).optional(),
});

function canView(scope: ProjectScope): void {
  need(scope, { post: ["view"] });
}

async function creatorNames(scope: ProjectScope, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const wanted = new Set(ids.filter((i): i is string => i !== null));
  if (wanted.size === 0) return new Map();
  const members = await scope.members.list();
  return new Map(members.filter((m) => wanted.has(m.userId)).map((m) => [m.userId, m.name]));
}

async function keyNames(scope: ProjectScope, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((i): i is string => i !== null))];
  const keys = await Promise.all(wanted.map((id) => scope.apiKeys.get(id)));
  return new Map(keys.filter((k) => k !== null).map((k) => [k.id, k.name]));
}

function toListItem(job: JobRecord, counts: JobCounts, names: Map<string, string>, keys: Map<string, string>): JobListItem {
  return {
    id: job.id,
    sourceKind: job.sourceKind,
    sourceSummary: job.sourceSummary,
    createdBy: job.createdByUserId ? { id: job.createdByUserId, name: names.get(job.createdByUserId) ?? "Former member" } : null,
    createdByKey: job.createdByApiKeyId ? { id: job.createdByApiKeyId, name: keys.get(job.createdByApiKeyId) ?? "Deleted key" } : null,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    itemCount: job.itemCount,
    approval: job.approvalPolicy,
    scheduling: job.schedulingPolicy,
    unreviewedQueue: job.approvalPolicy === "auto_approve" && job.schedulingPolicy === "add_to_queue",
    status: job.status,
    open: job.open,
    counts,
    finishedAt: job.finishedAt,
    cancelledAt: job.cancelledAt,
  };
}

export async function listJobs(
  scope: ProjectScope,
  input: unknown = {},
): Promise<{ items: JobListItem[]; total: number; page: number }> {
  canView(scope);
  const parsed = pageSchema.parse(input ?? {});
  const page = parsed.page ?? 1;
  const limit = parsed.limit ?? JOBS_PAGE_SIZE;
  const { rows, total } = await scope.jobs.list({ limit, offset: parsed.offset ?? (page - 1) * JOBS_PAGE_SIZE });
  const [counts, names, keys] = await Promise.all([
    scope.jobs.countsFor(rows.map((r) => r.id)),
    creatorNames(scope, rows.map((r) => r.createdByUserId)),
    keyNames(scope, rows.map((r) => r.createdByApiKeyId)),
  ]);
  return {
    items: rows.map((r) => toListItem(r, counts.get(r.id) ?? { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0 }, names, keys)),
    total,
    page,
  };
}

export async function getJob(scope: ProjectScope, jobId: string) {
  canView(scope);
  const id = z.uuid().safeParse(jobId);
  if (!id.success) throw new NotFoundError();
  const job = await scope.jobs.get(id.data);
  if (!job) throw new NotFoundError();
  const [counts, names, keys, profile, version] = await Promise.all([
    scope.jobItems.countByStatus(job.id),
    creatorNames(scope, [job.createdByUserId]),
    keyNames(scope, [job.createdByApiKeyId]),
    scope.voiceProfiles.get(job.voiceProfileId),
    scope.voiceVersions.get(job.voiceProfileVersionId),
  ]);
  const targets = await Promise.all(
    job.targetAccountIds.map(async (accountId) => {
      const account = await scope.accounts.get(accountId);
      return {
        id: accountId,
        displayName: account?.displayName ?? "Removed account",
        providerKey: account?.providerKey ?? "",
        removed: !account,
      };
    }),
  );
  const budget = schedulerConfig(getEnv()).timeBudgetMs;
  const needed = JOB_MIN_CALL_MS + JOB_PERSIST_RESERVE_MS;
  return {
    ...toListItem(job, counts, names, keys),
    voice: {
      profileId: job.voiceProfileId,
      name: profile?.name ?? "Voice profile",
      version: version?.version ?? 0,
      archived: profile?.archivedAt != null,
    },
    template: job.template,
    templateFields: job.templateFields,
    targets,
    requested: { approval: job.requestedApproval, scheduling: job.requestedScheduling },
    sourceMeta: (job.sourceMeta ?? {}) as Record<string, unknown>,
    generationConfigured: getLlmStatus().configured,
    jobsRunnable:
      budget >= needed
        ? ({ ok: true } as const)
        : ({
            ok: false,
            message: `The scheduler tick budget (${Math.round(budget / 1000)} s) is too short to generate a post. Raise SCHEDULER_TICK_BUDGET_SECONDS to at least ${Math.ceil(needed / 1000)}.`,
          } as const),
  };
}

export interface JobItemView {
  id: string;
  position: number;
  label: string;
  status: JobItemStatus;
  attemptCount: number;
  mediaId: string | null;
  media: { id: string; thumbnailUrl: string | null; altText: string } | null;
  post: { id: string; reviewState: string; status: string } | null;
  error: { kind: ItemErrorKind; message: string } | null;
  finishedAt: Date | null;
}

export async function listJobItems(
  scope: ProjectScope,
  jobId: string,
  input: unknown = {},
): Promise<{ items: JobItemView[]; total: number; page: number }> {
  canView(scope);
  const { page = 1, status, limit, offset } = z
    .object({
      page: z.number().int().min(1).max(10_000).optional(),
      limit: z.number().int().min(1).max(500).optional(),
      offset: z.number().int().min(0).optional(),
      status: z.enum(["queued", "running", "done", "failed", "cancelled"]).optional(),
    })
    .parse(input ?? {});
  const job = await getJobRow(scope, jobId);
  const rows = await scope.jobItems.listForJob(job.id, {
    ...(status ? { status } : {}),
    limit: limit ?? JOB_ITEMS_PAGE_SIZE,
    offset: offset ?? (page - 1) * JOB_ITEMS_PAGE_SIZE,
  });
  const counts = await scope.jobItems.countByStatus(job.id);
  const total = status ? counts[status] : job.itemCount;

  const items = await Promise.all(rows.map((row) => toItemView(scope, row)));
  return { items, total, page };
}

async function toItemView(scope: ProjectScope, row: JobItemRecord): Promise<JobItemView> {
  const asset = row.mediaAssetId ? await scope.media.getIncludingDeleted(row.mediaAssetId) : null;
  const view = asset ? await toView(asset) : null;
  const post = await scope.posts.findByJobItemId(row.id);
  return {
    id: row.id,
    position: row.position,
    label: row.label,
    status: row.status,
    attemptCount: row.attemptCount,
    mediaId: row.mediaAssetId,
    media: view ? { id: view.id, thumbnailUrl: view.thumbnailUrl, altText: view.altText } : null,
    post: post ? { id: post.id, reviewState: post.reviewState, status: post.status } : null,
    error: row.lastErrorKind && row.lastError && row.status !== "done" ? { kind: row.lastErrorKind, message: row.lastError } : null,
    finishedAt: row.finishedAt,
  };
}

/** One item of a job; 404 if it is not on that job. */
export async function getJobItem(scope: ProjectScope, jobId: string, itemId: string): Promise<JobItemView> {
  canView(scope);
  const job = await getJobRow(scope, jobId);
  const id = z.uuid().safeParse(itemId);
  if (!id.success) throw new NotFoundError();
  const row = await scope.jobItems.get(id.data);
  if (!row || row.jobId !== job.id) throw new NotFoundError();
  return toItemView(scope, row);
}

async function getJobRow(scope: ProjectScope, jobId: string): Promise<JobRecord> {
  const id = z.uuid().safeParse(jobId);
  if (!id.success) throw new NotFoundError();
  const job = await scope.jobs.get(id.data);
  if (!job) throw new NotFoundError();
  return job;
}
