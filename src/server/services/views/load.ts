import type { ApiJob, ApiPost } from "@/lib/api/schemas";
import { NotFoundError } from "../../dal/errors";
import type { JobRecord } from "../../dal/jobs";
import type { PostRecord } from "../../dal/posts";
import type { ProjectScope } from "../../dal/scope";
import { need } from "../generation/single";
import { toView } from "../media";
import { getPost } from "../posts";
import { toApiPost } from "./post";
import { toApiJob } from "./job";

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
      return row ? { id, url: (await toView(row)).publicUrl, altText: row.altText, kind: row.kind === "video" ? ("video" as const) : ("image" as const) } : { id, url: null, altText: "" };
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
