import type { ApiJob, ApiJobItem, ApiJobSummary, ApiPost } from "@/lib/api/schemas";
import { NotFoundError } from "../../dal/errors";
import type { JobItemRecord, JobRecord } from "../../dal/jobs";
import type { PostRecord } from "../../dal/posts";
import type { ProjectScope } from "../../dal/scope";
import { need } from "../generation/single";
import { toView } from "../media";
import { getPost } from "../posts";
import { toApiPost } from "./post";
import { toApiJob, toApiJobItem, toApiJobSummary } from "./job";

/** Who made the post: the key's name, the member's display name, or "Former member". */
async function creatorOf(scope: ProjectScope, post: PostRecord): Promise<ApiPost["createdBy"]> {
  if (post.createdByApiKeyId) {
    const key = await scope.apiKeys.get(post.createdByApiKeyId);
    return { type: "api_key", name: key?.name ?? "Deleted key" };
  }
  if (post.createdByUserId) {
    const member = (await scope.members.list()).find((m) => m.userId === post.createdByUserId);
    return { type: "user", name: member?.name ?? "Former member" };
  }
  return null;
}

/** The `Post` shape of the public API, built from the same reads the UI uses. */
export async function loadApiPost(scope: ProjectScope, postId: string): Promise<ApiPost> {
  const { post, mediaIds } = await getPost(scope, postId);
  const [targets, accountList, media, createdBy] = await Promise.all([
    scope.targets.listForPost(post.id),
    scope.accounts.list(),
    scope.media.getMany(mediaIds),
    creatorOf(scope, post),
  ]);
  const byId = new Map(media.map((m) => [m.id, m]));
  const views = await Promise.all(
    mediaIds.map(async (id) => {
      const row = byId.get(id);
      return row ? { id, url: (await toView(row)).publicUrl, altText: row.altText } : { id, url: null, altText: "" };
    }),
  );
  return toApiPost({
    post,
    targets,
    accounts: new Map(accountList.map((a) => [a.id, a])),
    media: views,
    timeZone: scope.project.timezone,
    createdBy,
  });
}

async function jobCreator(scope: ProjectScope, job: JobRecord): Promise<ApiJob["createdBy"]> {
  if (job.createdByApiKeyId) {
    const key = await scope.apiKeys.get(job.createdByApiKeyId);
    return { type: "api_key", name: key?.name ?? "Deleted key" };
  }
  if (job.createdByUserId) {
    const member = (await scope.members.list()).find((m) => m.userId === job.createdByUserId);
    return { type: "user", name: member?.name ?? "Former member" };
  }
  return null;
}

/** The `Job` shape of the public API. Reads the row directly: the service reads built for the UI carry screen-only data. */
export async function loadApiJob(scope: ProjectScope, jobId: string): Promise<ApiJob> {
  need(scope, { post: ["view"] });
  const job = await scope.jobs.get(jobId);
  if (!job) throw new NotFoundError();
  const [counts, createdBy] = await Promise.all([scope.jobItems.countByStatus(job.id), jobCreator(scope, job)]);
  return toApiJob(job, counts, createdBy);
}

export async function loadApiJobSummaries(scope: ProjectScope, rows: readonly JobRecord[]): Promise<ApiJobSummary[]> {
  need(scope, { post: ["view"] });
  const counts = await scope.jobs.countsFor(rows.map((r) => r.id));
  return Promise.all(
    rows.map(async (r) =>
      toApiJobSummary(r, counts.get(r.id) ?? { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0 }, await jobCreator(scope, r)),
    ),
  );
}

export async function loadApiJobItems(
  scope: ProjectScope,
  jobId: string,
  opts: { status?: "queued" | "running" | "done" | "failed" | "cancelled"; limit: number; offset: number },
): Promise<ApiJobItem[]> {
  need(scope, { post: ["view"] });
  const rows = await scope.jobItems.listForJob(jobId, opts);
  return Promise.all(rows.map((row) => loadItem(scope, row)));
}

async function loadItem(scope: ProjectScope, row: JobItemRecord): Promise<ApiJobItem> {
  const post = await scope.posts.findByJobItemId(row.id);
  return toApiJobItem(row, post ? { id: post.id, reviewState: post.reviewState } : null);
}

export async function loadApiJobItem(scope: ProjectScope, jobId: string, itemId: string): Promise<ApiJobItem> {
  need(scope, { post: ["view"] });
  const row = await scope.jobItems.get(itemId);
  if (!row || row.jobId !== jobId) throw new NotFoundError();
  return loadItem(scope, row);
}
