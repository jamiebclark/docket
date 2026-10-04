"use server";

import { refresh } from "next/cache";
import type { ActionResult } from "@/lib/action-result";
import * as queue from "@/server/services/queue";
import { runAction } from "../run-action";

export async function moveToOccurrenceAction(
  slug: string,
  input: { targetId: string; slotId: string; scheduledAt: string },
): Promise<ActionResult<queue.PlannedTime>> {
  const result = await runAction(slug, (scope) => queue.moveTargetToOccurrence(scope, input));
  if (result.ok) refresh();
  return result;
}

export async function moveToNextFreeAction(slug: string, input: { targetId: string }): Promise<ActionResult<queue.PlannedTime>> {
  const result = await runAction(slug, (scope) => queue.moveToNextFreeSlot(scope, input?.targetId));
  if (result.ok) refresh();
  return result;
}

export async function swapTargetsAction(slug: string, input: { targetIdA: string; targetIdB: string }): Promise<ActionResult<void>> {
  const result = await runAction(slug, (scope) => queue.swapQueuedTargets(scope, input?.targetIdA, input?.targetIdB));
  if (result.ok) refresh();
  return result;
}

export async function listQueuedForAccountAction(slug: string, input: { accountId: string }): Promise<ActionResult<queue.QueuedItem[]>> {
  return runAction(slug, (scope) => queue.listQueuedForAccount(scope, input?.accountId));
}

export async function listEmptySlotsAction(
  slug: string,
  input: { accountId: string; from: string; to: string },
): Promise<ActionResult<queue.EmptySlot[]>> {
  return runAction(slug, (scope) => queue.listEmptySlots(scope, input));
}

export async function previewPullForwardAction(slug: string, input: { accountId: string }): Promise<ActionResult<{ moved: queue.PullMove[] }>> {
  return runAction(slug, (scope) => queue.previewPullQueueForward(scope, input?.accountId));
}

export async function pullForwardAction(
  slug: string,
  input: { accountId: string; expected?: queue.PullExpected[] },
): Promise<ActionResult<{ moved: queue.PullMove[] }>> {
  const result = await runAction(slug, (scope) => queue.pullQueueForward(scope, input?.accountId, { expected: input?.expected }));
  if (result.ok) refresh();
  return result;
}
