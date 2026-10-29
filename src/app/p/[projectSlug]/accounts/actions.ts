"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { classifyConnect, landingHref } from "@/lib/accounts/connect-landing";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { formatLocal } from "@/components/ui/LocalTime";
import { getSession } from "@/server/auth/session";
import * as accounts from "@/server/services/accounts";
import * as connect from "@/server/services/connect";
import * as slots from "@/server/services/slots";
import { runAction } from "../run-action";

/**
 * Every mutation refreshes the route so the server-rendered account sections show the new state.
 *
 * Use this only for actions the browser stays on. An action that hands the client a `landing` URL
 * must NOT also `refresh()`: refresh tells the client router to re-render the route it is on, and
 * the form then calls `router.push(landing)`, which tears that render down mid-stream. Next reports
 * "The destination stream closed early" and the route's error boundary shows "Something went
 * wrong" — *after* the connect has already succeeded, so the account is live and the person is told
 * it failed. That is how a working Bluesky reconnect looked broken on 2026-10-17. The landing URL
 * carries its own query (`?landed=…&connected=…&reconnected=…`), so the push fetches the
 * destination fresh and the refresh buys nothing. `chooseConnectCandidatesAction` is the exception
 * that proves it: it redirects server-side, where Next sequences the refresh and the navigation.
 * `tests/lint/connect-landing-no-refresh.test.ts` holds the line.
 */
async function mutate<T>(slug: string, fn: Parameters<typeof runAction<T>>[1]): Promise<ActionResult<T>> {
  const result = await runAction(slug, fn);
  if (result.ok) refresh();
  return result;
}

export type ConnectedAccount = accounts.AccountView & { landing: string };

/** Where the browser goes after a successful connect: the first new account's slots, or the card for a reconnect. */
function landingFor(slug: string, saved: accounts.AccountView[], priorIds: ReadonlySet<string>): string {
  const landing = classifyConnect(saved, priorIds);
  return landing ? landingHref(slug, landing) : `/p/${encodeURIComponent(slug)}/accounts`;
}

export async function connectMockAction(
  slug: string,
  input: { displayName: string; simulateCredentialExpiryHours?: number },
): Promise<ActionResult<ConnectedAccount>> {
  // runAction, not mutate: the client navigates to `landing` on success (see above).
  return runAction(slug, async (scope) => {
    const account = await accounts.connectMock(scope, input);
    return { ...account, landing: landingFor(slug, [account], new Set()) };
  });
}

/** Never echoes `input.fields`: the result carries the account view or an error message only. */
export async function connectCredentialsAction(
  slug: string,
  input: { providerKey: string; fields: Record<string, string>; accountId?: string },
): Promise<ActionResult<ConnectedAccount>> {
  const result = await runAction(slug, async (scope) => {
    const priorIds = new Set((await accounts.listAccounts(scope)).map((a) => a.id));
    return { outcome: await accounts.connectWithCredentials(scope, input), timeZone: scope.project.timezone, priorIds };
  });
  if (!result.ok) return result;
  const { outcome, timeZone, priorIds } = result.data;
  if (!outcome.ok) {
    const when = outcome.retryAt
      ? ` Try again after ${formatLocal(outcome.retryAt, timeZone)}.`
      : "";
    return fail("validation", `${outcome.message}${when}`, outcome.fieldErrors);
  }
  // No refresh() here: the client pushes to `landing` on success (see the note above).
  return ok({ ...outcome.account, landing: landingFor(slug, [outcome.account], priorIds) });
}

export async function reconnectMockAction(slug: string, input: { id: string }): Promise<ActionResult<ConnectedAccount>> {
  // runAction, not mutate: the client navigates to `landing` on success (see above).
  return runAction(slug, async (scope) => {
    const account = await accounts.reconnectMock(scope, input?.id);
    return { ...account, landing: landingFor(slug, [account], new Set([account.id])) };
  });
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

export async function setAccountDisabledAction(
  slug: string,
  input: { id: string; disabled: boolean },
): Promise<ActionResult<{ changed: boolean; releasedTargets: number }>> {
  return mutate(slug, async (scope) => {
    const out = await accounts.setAccountDisabled(scope, input?.id, input?.disabled === true);
    return { changed: out.changed, releasedTargets: out.releasedTargets };
  });
}

export async function accountDisableImpactAction(
  slug: string,
  input: { id: string },
): Promise<ActionResult<{ queuedPosts: number }>> {
  return runAction(slug, (scope) => accounts.accountDisableImpact(scope, input?.id));
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

export async function addWeekSlotsAction(
  slug: string,
  input: { accountId: string; localTime: string },
): Promise<ActionResult<slots.WeekSlotsResult>> {
  return mutate(slug, (scope) => slots.addSlotsForWeek(scope, input));
}

export async function moveSlotAction(
  slug: string,
  input: { id: string; weekday: number; localTime: string },
): Promise<ActionResult<slots.SlotView>> {
  return mutate(slug, (scope) => slots.moveSlot(scope, input));
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
    const priorIds = new Set((await accounts.listAccounts(scope)).map((a) => a.id));
    const outcome = await connect.chooseConnectCandidates(
      scope,
      { attemptId: input?.attemptId, selected: Array.isArray(input?.selected) ? input.selected : [] },
      binding,
    );
    return { outcome, priorIds };
  });
  if (!result.ok) return result;
  const { outcome, priorIds } = result.data;
  if (!outcome.ok) return fail("validation", outcome.message);
  refresh();
  redirect(landingFor(slug, outcome.saved, priorIds));
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

export async function setPostingInstructionsAction(
  slug: string,
  input: { accountId: string; instructions: string },
): Promise<ActionResult<{ changed: boolean; instructions: string | null }>> {
  return mutate(slug, (scope) =>
    accounts.setPostingInstructions(scope, input?.accountId, { instructions: input?.instructions }),
  );
}
