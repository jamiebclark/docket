"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { getSession } from "@/server/auth/session";
import * as accounts from "@/server/services/accounts";
import * as connect from "@/server/services/connect";
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

/** Never echoes `input.fields`: the result carries the account view or an error message only. */
export async function connectCredentialsAction(
  slug: string,
  input: { providerKey: string; fields: Record<string, string>; accountId?: string },
): Promise<ActionResult<accounts.AccountView>> {
  const result = await runAction(slug, async (scope) => ({
    outcome: await accounts.connectWithCredentials(scope, input),
    timeZone: scope.project.timezone,
  }));
  if (!result.ok) return result;
  const { outcome, timeZone } = result.data;
  if (!outcome.ok) {
    const when = outcome.retryAt
      ? ` Try again after ${new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone }).format(outcome.retryAt)} (${timeZone}).`
      : "";
    return fail("validation", `${outcome.message}${when}`, outcome.fieldErrors);
  }
  refresh();
  return ok(outcome.account);
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

/** The session id comes from the server, never from the client. */
async function sessionBinding(): Promise<connect.ConnectSession | null> {
  const session = await getSession();
  return session ? { sessionId: session.session.id } : null;
}

/** Redirects to the platform's login dialog on success (the redirect runs outside the action's error handling). */
export async function startOAuthConnectAction(slug: string, input: { groupKey: string }): Promise<ActionResult<never>> {
  const binding = await sessionBinding();
  if (!binding) return fail("unauthenticated", "Sign in to continue.");
  const result = await runAction(slug, (scope) => connect.startOAuthConnect(scope, { groupKey: input?.groupKey }, binding));
  if (!result.ok) return result;
  redirect(result.data.url);
}

export async function chooseConnectCandidatesAction(
  slug: string,
  input: { attemptId: string; selected: string[] },
): Promise<ActionResult<{ saved: number }>> {
  const binding = await sessionBinding();
  if (!binding) return fail("unauthenticated", "Sign in to continue.");
  const result = await runAction(slug, async (scope) => {
    const outcome = await connect.chooseConnectCandidates(
      scope,
      { attemptId: input?.attemptId, selected: Array.isArray(input?.selected) ? input.selected : [] },
      binding,
    );
    return outcome;
  });
  if (!result.ok) return result;
  if (!result.data.ok) return fail("validation", result.data.message);
  refresh();
  redirect(`/p/${slug}/accounts`);
}

/** Never echoes `input.token`; redirects to the chooser on success. */
export async function pasteConnectTokenAction(
  slug: string,
  input: { groupKey: string; token: string },
): Promise<ActionResult<never>> {
  const binding = await sessionBinding();
  if (!binding) return fail("unauthenticated", "Sign in to continue.");
  const result = await runAction(slug, (scope) =>
    connect.pasteConnectToken(scope, { groupKey: input?.groupKey, token: input?.token }, binding),
  );
  if (!result.ok) return result;
  if (!result.data.ok) return fail("validation", result.data.message);
  redirect(`/p/${slug}/accounts/connect/${result.data.attemptId}`);
}
