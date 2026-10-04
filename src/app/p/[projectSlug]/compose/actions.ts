"use server";

import { refresh } from "next/cache";
import type { ActionResult } from "@/lib/action-result";
import * as posts from "@/server/services/posts";
import { runAction } from "../run-action";

type Queued = Awaited<ReturnType<typeof posts.addToQueue>>;
type Preview = Awaited<ReturnType<typeof posts.previewQueue>>;

/** Creates a draft, or saves the composer state into `postId`. */
export async function saveDraftAction(slug: string, input: unknown): Promise<ActionResult<{ postId: string }>> {
  const result = await runAction(slug, async (scope) => {
    const { postId, ...content } = (input ?? {}) as { postId?: string };
    const saved = postId ? await posts.updatePost(scope, postId, content) : await posts.createDraft(scope, content);
    return { postId: saved.post.id };
  });
  if (result.ok) refresh();
  return result;
}

export async function previewQueueAction(slug: string, input: { postId: string }): Promise<ActionResult<Preview>> {
  return runAction(slug, (scope) => posts.previewQueue(scope, input?.postId));
}

export async function addToQueueAction(
  slug: string,
  input: { postId: string; targetIds?: string[]; expected?: Record<string, string> },
): Promise<ActionResult<Queued>> {
  const result = await runAction(slug, (scope) => {
    const { postId, ...rest } = input ?? ({} as typeof input);
    return posts.addToQueue(scope, postId, rest);
  });
  if (result.ok) refresh();
  return result;
}

type Scheduled = Awaited<ReturnType<typeof posts.scheduleAt>>;
type ExplicitPreview = Awaited<ReturnType<typeof posts.previewExplicitTime>>;

export async function previewExplicitTimeAction(slug: string, input: unknown): Promise<ActionResult<ExplicitPreview>> {
  return runAction(slug, (scope) => posts.previewExplicitTime(scope, input));
}

/** `at` is an ISO instant, normally the `instant` from `previewExplicitTimeAction`. */
export async function scheduleAtAction(
  slug: string,
  input: { postId: string; at: string; targetIds?: string[] },
): Promise<ActionResult<Scheduled>> {
  const result = await runAction(slug, (scope) => {
    const { postId, ...rest } = input ?? ({} as typeof input);
    return posts.scheduleAt(scope, postId, rest);
  });
  if (result.ok) refresh();
  return result;
}

export async function publishNowAction(
  slug: string,
  input: { postId: string; targetIds?: string[] },
): Promise<ActionResult<Scheduled>> {
  const result = await runAction(slug, (scope) => {
    const { postId, ...rest } = input ?? ({} as typeof input);
    return posts.publishNow(scope, postId, rest);
  });
  if (result.ok) refresh();
  return result;
}
