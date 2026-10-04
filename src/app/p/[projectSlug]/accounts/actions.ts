"use server";

import { refresh } from "next/cache";
import type { ActionResult } from "@/lib/action-result";
import * as accounts from "@/server/services/accounts";
import * as slots from "@/server/services/slots";
import { runAction } from "../run-action";

/** Every mutation refreshes the route so the server-rendered account sections show the new state. */
async function mutate<T>(slug: string, fn: Parameters<typeof runAction<T>>[1]): Promise<ActionResult<T>> {
  const result = await runAction(slug, fn);
  if (result.ok) refresh();
  return result;
}

export async function connectMockAction(
  slug: string,
  input: { displayName: string; simulateCredentialExpiryHours?: number },
): Promise<ActionResult<accounts.AccountView>> {
  return mutate(slug, (scope) => accounts.connectMock(scope, input));
}

export async function reconnectMockAction(slug: string, input: { id: string }): Promise<ActionResult<accounts.AccountView>> {
  return mutate(slug, (scope) => accounts.reconnectMock(scope, input?.id));
}

export async function setMockBehaviourAction(
  slug: string,
  input: { id: string; settings: unknown },
): Promise<ActionResult<null>> {
  return mutate(slug, async (scope) => {
    await accounts.updateAccountSettings(scope, input?.id, input?.settings);
    return null;
  });
}

export async function removeAccountAction(slug: string, input: { id: string }): Promise<ActionResult<null>> {
  return mutate(slug, async (scope) => {
    await accounts.removeAccount(scope, input?.id);
    return null;
  });
}

export async function accountRemovalImpactAction(
  slug: string,
  input: { id: string },
): Promise<ActionResult<{ unpublishedPosts: number }>> {
  return runAction(slug, (scope) => accounts.accountRemovalImpact(scope, input?.id));
}

export async function addSlotAction(
  slug: string,
  input: { accountId: string; weekday: number; localTime: string },
): Promise<ActionResult<slots.SlotView>> {
  return mutate(slug, (scope) => slots.addSlot(scope, input));
}

export async function setSlotPausedAction(slug: string, input: { id: string; paused: boolean }): Promise<ActionResult<null>> {
  return mutate(slug, async (scope) => {
    await slots.setSlotPaused(scope, input?.id, input?.paused === true);
    return null;
  });
}

export async function deleteSlotAction(slug: string, input: { id: string }): Promise<ActionResult<null>> {
  return mutate(slug, async (scope) => {
    await slots.deleteSlot(scope, input?.id);
    return null;
  });
}
