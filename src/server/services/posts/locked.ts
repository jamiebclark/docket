import { z } from "zod";
import { ForbiddenError, NotFoundError } from "../../dal/errors";
import type { PostRecord } from "../../dal/posts";
import type { ProjectScope } from "../../dal/scope";
import type { TargetRecord } from "../../dal/targets";
import * as clock from "../../dal/clock";
import { applyDerivedStatus } from "./status";

type Tx = ProjectScope;
const uuid = z.uuid();

export function need(scope: ProjectScope, request: Parameters<ProjectScope["can"]>[0]): void {
  if (!scope.can(request)) throw new ForbiddenError();
}

export async function lockPost(tx: Tx, postId: string): Promise<PostRecord> {
  const post = await tx.posts.lockForUpdate(postId);
  if (!post) throw new NotFoundError();
  // Post lock first, then the target rows: waits out a scheduler claim so later reads see its lease.
  await tx.targets.lockForPost(postId);
  return post;
}

/** Reads the target to find its post, locks the post, then re-reads the target under the lock. */
export async function withLockedTarget<T>(
  scope: ProjectScope,
  targetId: string,
  permission: Parameters<ProjectScope["can"]>[0],
  fn: (tx: Tx, post: PostRecord, target: TargetRecord, now: Date) => Promise<T>,
  opts?: { postId?: string },
): Promise<T> {
  const id = uuid.parse(targetId);
  need(scope, permission);
  return scope.transaction(async (tx) => {
    need(tx, permission);
    const first = await tx.targets.get(id);
    if (!first) throw new NotFoundError();
    // A target addressed through a post path must belong to that post: refuse before any lock or write.
    if (opts?.postId !== undefined && first.postId !== opts.postId) throw new NotFoundError();
    const post = await lockPost(tx, first.postId);
    const target = await tx.targets.get(id);
    if (!target) throw new NotFoundError();
    const result = await fn(tx, post, target, await clock.now());
    await applyDerivedStatus(tx, post.id);
    return result;
  });
}
