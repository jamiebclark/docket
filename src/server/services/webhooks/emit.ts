import type { ApiPost } from "@/lib/api/schemas";
import type { ProjectScope } from "../../dal/scope";
import * as clock from "../../dal/clock";
import { NotFoundError } from "../../dal/errors";
import type { WebhookEventType } from "../../dal/webhooks";
import { toView } from "../media";
import { toApiAccount } from "../views/account";
import { toApiJob } from "../views/job";
import { toApiPost } from "../views/post";

/** What an emitting transaction must carry: scheduler repos suffice for posts and accounts. */
export type EmitRepos = Pick<ProjectScope, "webhooks" | "posts" | "targets" | "accounts" | "media">;
export type EmitSubject = { postId: string } | { jobId: string } | { accountId: string };

async function postData(tx: EmitRepos, postId: string): Promise<{ data: ApiPost; subjectId: string }> {
  const post = await tx.posts.get(postId);
  if (!post) throw new NotFoundError();
  const mediaIds = await tx.posts.listMediaIds(postId);
  const [targets, accounts, media, timeZone] = await Promise.all([
    tx.targets.listForPost(postId),
    tx.accounts.list(),
    tx.media.getMany(mediaIds),
    tx.webhooks.projectTimeZone(),
  ]);
  const byId = new Map(media.map((m) => [m.id, m]));
  const views = await Promise.all(
    mediaIds.map(async (id) => {
      const row = byId.get(id);
      return row ? { id, url: (await toView(row)).publicUrl, altText: row.altText } : { id, url: null, altText: "" };
    }),
  );
  const data = toApiPost({
    post,
    targets,
    accounts: new Map(accounts.map((a) => [a.id, a])),
    media: views,
    timeZone,
    createdBy: post.createdByApiKeyId ? { type: "api_key", name: "API key" } : null,
  });
  return { data, subjectId: postId };
}

/**
 * Inserts one event and one pending delivery per subscribed endpoint, in the caller's transaction.
 * No subscribers → no writes (contracts/webhooks.md "Emission").
 */
export async function emitEvent(tx: EmitRepos, type: WebhookEventType, subject: EmitSubject): Promise<void> {
  const endpointIds = await tx.webhooks.subscribedEndpointIds(type);
  if (endpointIds.length === 0) return;

  let data: unknown;
  let subjectId: string;
  if ("postId" in subject) {
    ({ data, subjectId } = await postData(tx, subject.postId));
  } else if ("accountId" in subject) {
    const account = await tx.accounts.get(subject.accountId);
    if (!account) throw new NotFoundError();
    data = toApiAccount(account);
    subjectId = account.id;
  } else {
    const scope = tx as ProjectScope;
    const job = await scope.jobs.get(subject.jobId);
    if (!job) throw new NotFoundError();
    data = toApiJob(job, await scope.jobItems.countByStatus(job.id), job.createdByApiKeyId ? { type: "api_key", name: "API key" } : null);
    subjectId = job.id;
  }

  const id = crypto.randomUUID();
  const createdAt = (await clock.now()).toISOString();
  const event = await tx.webhooks.insertEvent({
    id,
    type,
    subjectId,
    body: { id, type, createdAt, projectId: tx.webhooks.projectId, data },
  });
  await tx.webhooks.insertDeliveries(event.id, endpointIds);
}
