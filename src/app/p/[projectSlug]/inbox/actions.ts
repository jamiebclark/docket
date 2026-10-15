"use server";

import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/lib/action-result";
import { editDraft, requestDraft, writeReply, type RequestDraftResult } from "@/server/services/engagement/draft";
import { dismissItems } from "@/server/services/engagement/review";
import { runAction } from "../run-action";

const revalidate = (slug: string, itemId: string) => revalidatePath(`/p/${slug}/inbox/${itemId}`);

export async function requestDraftAction(slug: string, input: { itemId: string }): Promise<ActionResult<RequestDraftResult>> {
  const result = await runAction(slug, (scope) => requestDraft(scope, input?.itemId));
  if (result.ok) revalidate(slug, input.itemId);
  return result;
}

type WriteReplyResult = Awaited<ReturnType<typeof writeReply>>;

export async function writeReplyAction(slug: string, input: { itemId: string; text: string }): Promise<ActionResult<WriteReplyResult>> {
  const result = await runAction(slug, (scope) => writeReply(scope, input?.itemId, input?.text));
  if (result.ok) revalidate(slug, input.itemId);
  return result;
}

type EditDraftResult = Awaited<ReturnType<typeof editDraft>>;

export async function editDraftAction(slug: string, input: { itemId: string; draftId: string; text: string }): Promise<ActionResult<EditDraftResult>> {
  const result = await runAction(slug, (scope) => editDraft(scope, input?.draftId, input?.text));
  if (result.ok) revalidate(slug, input.itemId);
  return result;
}

export async function dismissItemAction(slug: string, input: { itemId: string }): Promise<ActionResult<{ dismissed: number }>> {
  const result = await runAction(slug, (scope) => dismissItems(scope, [input?.itemId]));
  if (result.ok) revalidate(slug, input.itemId);
  return result;
}
