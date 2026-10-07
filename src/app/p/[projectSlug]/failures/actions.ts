"use server";

import { refresh } from "next/cache";
import type { ActionResult } from "@/lib/action-result";
import * as posts from "@/server/services/posts";
import { runAction } from "../run-action";

/** Only `{ account, mode }` ever reaches the service; the object is built from scratch. */
export async function retryAllFailedAction(
  slug: string,
  input: { account?: string; mode: "now" | "requeue" },
): Promise<ActionResult<posts.RetryAllResult>> {
  const body = { ...(input?.account ? { account: input.account } : {}), mode: input?.mode };
  const result = await runAction(slug, (scope) => posts.retryAllFailed(scope, body));
  if (result.ok) refresh();
  return result;
}

/** What a run would do. Reads only. */
export async function previewRetryAllAction(
  slug: string,
  input: { account?: string },
): Promise<ActionResult<posts.RetryAllPreview>> {
  const body = input?.account ? { account: input.account } : {};
  return runAction(slug, (scope) => posts.previewRetryAll(scope, body));
}
