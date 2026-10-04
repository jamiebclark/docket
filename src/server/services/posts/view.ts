import { z } from "zod";
import { findProvider } from "@/providers/registry";
import * as clock from "../../dal/clock";
import { ForbiddenError, NotFoundError } from "../../dal/errors";
import type { PostRecord } from "../../dal/posts";
import type { ProjectScope } from "../../dal/scope";
import type { TargetRecord } from "../../dal/targets";
import { getMedia } from "../media";
import { plannedTime } from "../queue";
import { hasLiveLease } from "./cancel";

export interface AttemptView {
  id: string;
  at: Date;
  step: string;
  outcome: string;
  /** Already redacted when written. */
  request: Record<string, unknown>;
  response: Record<string, unknown>;
  error: string | null;
}

export interface PostViewTarget {
  id: string;
  accountId: string;
  accountName: string;
  providerName: string;
  status: TargetRecord["status"];
  scheduleKind: TargetRecord["scheduleKind"];
  scheduledAt: Date | null;
  localTime: string | null;
  externalUrl: string | null;
  publishedAt: Date | null;
  lastError: string | null;
  inProgress: boolean;
  attempts: AttemptView[];
}

export type PostViewMedia = { id: string; deleted: true } | { id: string; deleted: false; thumbnailUrl: string; altText: string };

export interface PostView {
  post: Pick<PostRecord, "id" | "baseText" | "status" | "reviewState" | "createdAt" | "updatedAt">;
  targets: PostViewTarget[];
  media: PostViewMedia[];
  /** True while any target is published or publishing: the post can no longer be deleted. */
  deleteBlocked: boolean;
}

export async function getPostView(scope: ProjectScope, postId: string): Promise<PostView> {
  const id = z.uuid().parse(postId);
  if (!scope.can({ post: ["view"] })) throw new ForbiddenError();
  const post = await scope.posts.get(id);
  if (!post) throw new NotFoundError();
  const now = await clock.now();
  const accounts = new Map((await scope.accounts.list()).map((a) => [a.id, a]));
  const targets = await scope.targets.listForPost(id);
  const views = await Promise.all(
    targets.map(async (t): Promise<PostViewTarget> => {
      const account = accounts.get(t.socialAccountId);
      return {
        id: t.id,
        accountId: t.socialAccountId,
        accountName: account?.displayName ?? "Removed account",
        providerName: account ? (findProvider(account.providerKey)?.displayName ?? account.providerKey) : "",
        status: t.status,
        scheduleKind: t.scheduleKind,
        scheduledAt: t.scheduledAt,
        localTime: t.scheduledAt ? plannedTime(t.scheduledAt, t.slotId, scope.project.timezone).localTime : null,
        externalUrl: t.externalUrl,
        publishedAt: t.publishedAt,
        lastError: t.lastError,
        inProgress: hasLiveLease(t, now),
        attempts: (await scope.attempts.listForTarget(t.id)).map((a) => ({
          id: a.id,
          at: a.createdAt,
          step: a.step,
          outcome: a.outcome,
          request: (a.requestSummary ?? {}) as Record<string, unknown>,
          response: (a.responseSummary ?? {}) as Record<string, unknown>,
          error: a.error,
        })),
      };
    }),
  );
  const media: PostViewMedia[] = [];
  for (const mediaId of await scope.posts.listMediaIds(id)) {
    const row = await scope.media.getIncludingDeleted(mediaId);
    if (!row || row.deletedAt) {
      media.push({ id: mediaId, deleted: true });
      continue;
    }
    const v = await getMedia(scope, mediaId);
    media.push({ id: mediaId, deleted: false, thumbnailUrl: v.thumbnailUrl, altText: v.altText });
  }
  return {
    post: {
      id: post.id,
      baseText: post.baseText,
      status: post.status,
      reviewState: post.reviewState,
      createdAt: post.createdAt,
      updatedAt: post.updatedAt,
    },
    targets: views,
    media,
    deleteBlocked: targets.some((t) => t.status === "published" || t.status === "publishing" || t.status === "ambiguous"),
  };
}
