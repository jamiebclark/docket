"use server";

import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/lib/action-result";
import { approvePost, bulkApprove, rejectPost, type ApproveResult, type BulkApproveResult } from "@/server/services/review";
import { runAction } from "../run-action";

const revalidate = (slug: string) => revalidatePath(`/p/${slug}/review`);

type Rejected = Awaited<ReturnType<typeof rejectPost>>;

/** Approves a post, optionally saving edits first. A refusal (already reviewed, blocking problems) is data. */
export async function approveAction(
  slug: string,
  input: { postId: string; edits?: { accountIds: string[]; text: string }[] },
): Promise<ActionResult<ApproveResult>> {
  const result = await runAction(slug, (scope) => approvePost(scope, input?.postId, { edits: input?.edits }));
  if (result.ok) revalidate(slug);
  return result;
}

export async function rejectAction(
  slug: string,
  input: { postId: string; reason?: string | null },
): Promise<ActionResult<Rejected>> {
  const result = await runAction(slug, (scope) => rejectPost(scope, input?.postId, { reason: input?.reason ?? null }));
  if (result.ok) revalidate(slug);
  return result;
}

export async function bulkApproveAction(slug: string, input: { postIds: string[] }): Promise<ActionResult<BulkApproveResult>> {
  const result = await runAction(slug, (scope) => bulkApprove(scope, { postIds: input?.postIds }));
  if (result.ok) revalidate(slug);
  return result;
}
