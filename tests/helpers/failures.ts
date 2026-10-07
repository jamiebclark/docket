import { and, eq } from "drizzle-orm";
import { socialAccounts } from "../../src/server/db/schema/accounts";
import { runTick } from "../../src/server/scheduler";
import * as posts from "../../src/server/services/posts";
import { atTime } from "./clock";
import { testDb } from "./db";
import { postsEnv } from "./posts-env";

export const BEFORE = new Date("2026-10-01T12:00:00Z");
export const SLOT = new Date("2026-10-05T09:00:00Z");
export const LATER = new Date("2026-10-05T09:30:00Z");

type Env = Awaited<ReturnType<typeof postsEnv>>;

/** Queues a one-account post on a mock account with the given behaviour and runs its slot tick. */
export async function outcomeTarget(env: Env, behaviour: "ambiguous" | "fatal", text = "Hello") {
  const account = await env.account({ behaviour });
  const draft = await posts.createDraft(env.scope, { baseText: text, targets: [{ accountId: account.id }] });
  await atTime(BEFORE, () => posts.addToQueue(env.scope, draft.post.id, {}));
  await atTime(SLOT, () => runTick());
  const detail = await posts.getPost(env.scope, draft.post.id);
  return { account, postId: draft.post.id, targetId: detail.targets[0]!.id };
}

/** Flags an account the way the engine would, scoped by project like any other query. */
export async function setAccountStatus(projectId: string, id: string, status: "active" | "needs_reauth") {
  await testDb()
    .update(socialAccounts)
    .set({ status, lastError: status === "active" ? null : "expired" })
    .where(and(eq(socialAccounts.projectId, projectId), eq(socialAccounts.id, id)));
}

/** Soft-removes an account, or points it at a provider that is not registered. */
export async function breakAccount(projectId: string, id: string, how: "removed" | "provider_missing") {
  await testDb()
    .update(socialAccounts)
    .set(how === "removed" ? { removedAt: new Date() } : { providerKey: "no-such-provider" })
    .where(and(eq(socialAccounts.projectId, projectId), eq(socialAccounts.id, id)));
}
