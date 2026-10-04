import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { socialAccounts } from "../../../src/server/db/schema/accounts";
import { runTick } from "../../../src/server/scheduler";
import * as posts from "../../../src/server/services/posts";
import { atTime } from "../../helpers/clock";
import { closeDb, testDb } from "../../helpers/db";
import { BEFORE, SLOT } from "../../helpers/failures";
import { postsEnv } from "../../helpers/posts-env";
import { parkAllDueTargets } from "../../helpers/scheduling";

beforeEach(parkAllDueTargets);
afterAll(async () => {
  await closeDb();
});

async function queued(settings: Record<string, unknown>, patch?: (env: Awaited<ReturnType<typeof postsEnv>>, id: string) => Promise<void>) {
  const env = await postsEnv();
  const account = await env.account(settings);
  const draft = await posts.createDraft(env.scope, { baseText: "Hello", targets: [{ accountId: account.id }] });
  await atTime(BEFORE, () => posts.addToQueue(env.scope, draft.post.id, {}));
  await patch?.(env, account.id);
  await atTime(SLOT, () => runTick());
  const detail = await posts.getPost(env.scope, draft.post.id);
  return { env, target: detail.targets[0]!, attempts: await posts.listAttempts(env.scope, detail.targets[0]!.id) };
}

const update = (projectId: string, id: string, set: Partial<typeof socialAccounts.$inferInsert>) =>
  testDb().update(socialAccounts).set(set).where(and(eq(socialAccounts.projectId, projectId), eq(socialAccounts.id, id)));

describe("failures before the provider call are never ambiguous (FR-012)", () => {
  it("unreadable stored credentials fail the target with a reconnect message", async () => {
    const { target, attempts } = await queued({}, (env, id) => update(env.project.id, id, { credentialsEncrypted: "not-a-ciphertext" }).then(() => undefined));
    expect(target.status).toBe("failed");
    expect(target.lastError).toMatch(/stored credentials can't be read\. Reconnect /);
    expect(attempts[0]).toMatchObject({ outcome: "fatal_error" });
  });

  it("settings that no longer parse fail the target", async () => {
    const { target } = await queued({}, (env, id) => update(env.project.id, id, { settings: { behaviour: "no-such-behaviour" } }).then(() => undefined));
    expect(target.status).toBe("failed");
    expect(target.lastError).toBe("The account settings are invalid.");
  });

  it("a failure after the provider call started on a may-publish step stays ambiguous", async () => {
    const { target } = await queued({ behaviour: "throw" });
    expect(target.status).toBe("ambiguous");
  });
});
