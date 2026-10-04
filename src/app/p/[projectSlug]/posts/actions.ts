"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionResult } from "@/lib/action-result";
import * as posts from "@/server/services/posts";
import { runAction } from "../run-action";

export async function retryTargetAction(slug: string, input: { targetId: string }): Promise<ActionResult<void>> {
  const result = await runAction(slug, (scope) => posts.retryTarget(scope, input?.targetId));
  if (result.ok) refresh();
  return result;
}

export async function cancelTargetAction(slug: string, input: { targetId: string }): Promise<ActionResult<void>> {
  const result = await runAction(slug, (scope) => posts.cancelTarget(scope, input?.targetId));
  if (result.ok) refresh();
  return result;
}

export async function resolveTargetAction(
  slug: string,
  input: { targetId: string; outcome: "published" | "failed"; url?: string },
): Promise<ActionResult<void>> {
  const url = input?.url?.trim();
  const result = await runAction(slug, (scope) =>
    posts.resolveAmbiguous(scope, input?.targetId, input?.outcome === "published" ? { outcome: "published", ...(url ? { url } : {}) } : { outcome: input?.outcome }),
  );
  if (result.ok) refresh();
  return result;
}

/** Redirects to the list on success; on failure returns the result for the dialog to show. */
export async function deletePostAction(slug: string, input: { postId: string }): Promise<ActionResult<void>> {
  const result = await runAction(slug, (scope) => posts.deletePost(scope, input?.postId));
  if (result.ok) redirect(`/p/${slug}/posts`);
  return result;
}
