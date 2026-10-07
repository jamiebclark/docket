"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionResult } from "@/lib/action-result";
import { previewRequeue, type RequeuePreview } from "@/server/services/failures";
import * as posts from "@/server/services/posts";
import { runAction } from "../run-action";

type RetryActionInput =
  | { targetId: string; mode?: "now" }
  | { targetId: string; mode: "requeue"; expected?: string }
  | { targetId: string; mode: "at"; at: string };

export async function retryTargetAction(slug: string, input: RetryActionInput): Promise<ActionResult<posts.RetryResult>> {
  const { targetId, ...rest } = input ?? ({} as RetryActionInput);
  const body = rest.mode === undefined ? undefined : rest;
  const result = await runAction(slug, (scope) => posts.retryTarget(scope, targetId, body));
  if (result.ok) refresh();
  return result;
}

export async function cancelTargetAction(slug: string, input: { targetId: string }): Promise<ActionResult<void>> {
  const result = await runAction(slug, (scope) => posts.cancelTarget(scope, input?.targetId));
  if (result.ok) refresh();
  return result;
}

type ResolveInput =
  | { targetId: string; outcome: "published"; url?: string }
  | { targetId: string; outcome: "not_published"; requeue: boolean; expected?: string };

export async function resolveTargetAction(slug: string, input: ResolveInput): Promise<ActionResult<posts.ResolveResult>> {
  const { targetId, ...rest } = input ?? ({} as ResolveInput);
  const body =
    rest.outcome === "published"
      ? { outcome: "published", ...(rest.url?.trim() ? { url: rest.url.trim() } : {}) }
      : rest;
  const result = await runAction(slug, (scope) => posts.resolveAmbiguous(scope, targetId, body));
  if (result.ok) refresh();
  return result;
}

/** The slot a requeue would take. Reads only. */
export async function previewRequeueAction(slug: string, input: { targetId: string }): Promise<ActionResult<RequeuePreview>> {
  return runAction(slug, (scope) => previewRequeue(scope, input?.targetId));
}

/** Redirects to the list on success; on failure returns the result for the dialog to show. */
export async function deletePostAction(slug: string, input: { postId: string }): Promise<ActionResult<void>> {
  const result = await runAction(slug, (scope) => posts.deletePost(scope, input?.postId));
  if (result.ok) redirect(`/p/${slug}/posts`);
  return result;
}
