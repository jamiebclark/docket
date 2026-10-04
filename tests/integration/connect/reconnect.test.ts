import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { providers } from "../../../src/providers/registry";
import { metaConnectGroup } from "../../../src/providers/meta/connect-group";
import type { SocialProvider } from "../../../src/providers/types";
import { socialAccounts } from "../../../src/server/db/schema/accounts";
import { postTargets } from "../../../src/server/db/schema/posts";
import { decryptCredentials } from "../../../src/server/services/accounts";
import * as connect from "../../../src/server/services/connect";
import * as postsService from "../../../src/server/services/posts";
import { closeDb, testDb } from "../../helpers/db";
import { createFakeGraph } from "../../helpers/fake-graph";
import { sessionFor } from "../../helpers/connect-group";
import { postsEnv } from "../../helpers/posts-env";
import { createDueTarget } from "../../helpers/scheduling";

// The meta connect group with the real exchange code and a fake Graph. The platform providers are stood in
// for only when the real ones are not registered yet; the group, exchange and listing are the shipped ones.
const standIns: SocialProvider[] = [];
function standIn(key: string, displayName: string): SocialProvider {
  return {
    key,
    displayName,
    capabilities: {
      text: { maxLength: 100, countingRule: "graphemes" },
      media: { maxImages: 0, allowedMimeTypes: [], maxBytesPerFile: 0, required: false },
      textOnlyAllowed: true,
      postTypes: ["text"],
    },
    connect: { strategy: "oauth", group: metaConnectGroup },
    settingsSchema: z.object({}).passthrough(),
    validate: () => [],
    stepFor: () => ({ name: "publish", mayPublish: true }),
    advance: async () => ({ kind: "fatal_error", error: "not used" }),
  };
}

const fake = createFakeGraph();

beforeAll(() => {
  for (const [key, name] of [
    ["facebook", "Facebook"],
    ["instagram", "Instagram"],
  ] as const) {
    if (providers.some((p) => p.key === key)) continue;
    const p = standIn(key, name);
    standIns.push(p);
    (providers as SocialProvider[]).push(p);
  }
});
afterAll(async () => {
  for (const p of standIns) (providers as SocialProvider[]).splice(providers.indexOf(p), 1);
  await closeDb();
});
beforeEach(() => {
  vi.stubEnv("META_APP_ID", "12345");
  vi.stubEnv("META_APP_SECRET", "app-secret-value-0000");
  vi.stubEnv("META_GRAPH_VERSION", "v26.0");
  fake.reset();
  fake.install();
});
afterEach(() => {
  fake.uninstall();
  vi.unstubAllEnvs();
});

function loginReturns(pages: { id: string; name: string; token: string }[]) {
  fake.on("GET", "/v26.0/oauth/access_token", { kind: "ok", body: { access_token: "user-token-long" } });
  fake.on("GET", "/v26.0/me/accounts", {
    kind: "ok",
    body: { data: pages.map((p) => ({ id: p.id, name: p.name, access_token: p.token })) },
  });
}

/** Start -> platform redirect -> callback, through the real service, ending at the chooser. */
async function signIn(env: Awaited<ReturnType<typeof postsEnv>>, session: { sessionId: string }) {
  const { url } = await connect.startOAuthConnect(env.scope, { groupKey: "meta" }, session);
  const state = new URL(url).searchParams.get("state")!;
  const out = await connect.handleOAuthCallback(new URLSearchParams({ state, code: "CODE" }), {
    userId: env.owner.id,
    sessionId: session.sessionId,
  });
  if (out.kind !== "chooser") throw new Error(`expected chooser, got ${JSON.stringify(out)}`);
  return out.attemptId;
}

async function rowFor(externalId: string, projectId: string) {
  const rows = await testDb().select().from(socialAccounts).where(eq(socialAccounts.projectId, projectId));
  return rows.find((r) => r.externalAccountId === externalId)!;
}

describe("reconnecting a Facebook account through the chooser", () => {
  it("updates the same row in place: active, last_error cleared, new ciphertext", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    loginReturns([{ id: "100", name: "Acme", token: "OLD-PAGE-TOKEN" }]);
    const first = await signIn(env, session);
    await connect.chooseConnectCandidates(env.scope, { attemptId: first, selected: ["facebook:100"] }, session);
    const before = await rowFor("100", env.project.id);

    await testDb()
      .update(socialAccounts)
      .set({ status: "needs_reauth", lastError: "Facebook says the access token is no longer valid (code 190)." })
      .where(and(eq(socialAccounts.projectId, env.project.id), eq(socialAccounts.id, before.id)));

    loginReturns([{ id: "100", name: "Acme", token: "NEW-PAGE-TOKEN" }]);
    const second = await signIn(env, session);
    const choice = await connect.getConnectChoice(env.scope, second, session);
    expect(choice?.candidates[0]).toMatchObject({ key: "facebook:100", state: "needs_reauth" });
    const r = await connect.chooseConnectCandidates(env.scope, { attemptId: second, selected: ["facebook:100"] }, session);
    expect(r.ok && r.saved[0]).toMatchObject({ id: before.id, status: "active", lastError: null });

    const after = await rowFor("100", env.project.id);
    expect(after.id).toBe(before.id);
    expect(after.status).toBe("active");
    expect(after.lastError).toBeNull();
    expect(after.credentialsEncrypted).not.toEqual(before.credentialsEncrypted);
    expect(decryptCredentials(after.id, after.credentialsEncrypted)).toEqual({ pageToken: "NEW-PAGE-TOKEN" });
    expect(await testDb().select().from(socialAccounts).where(eq(socialAccounts.projectId, env.project.id))).toHaveLength(1);
  });

  it("lets a target failed by the revoked token be retried once the account is reconnected", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    loginReturns([{ id: "100", name: "Acme", token: "OLD-PAGE-TOKEN" }]);
    const first = await signIn(env, session);
    await connect.chooseConnectCandidates(env.scope, { attemptId: first, selected: ["facebook:100"] }, session);
    const account = await rowFor("100", env.project.id);
    const { target } = await createDueTarget(env.project.id, account.id);
    await testDb()
      .update(postTargets)
      .set({ status: "failed", nextAttemptAt: null, lastError: "Reconnect Acme to publish: Facebook says the access token is no longer valid (code 190/460)." })
      .where(and(eq(postTargets.projectId, env.project.id), eq(postTargets.id, target.id)));
    await testDb().update(socialAccounts).set({ status: "needs_reauth" }).where(and(eq(socialAccounts.projectId, env.project.id), eq(socialAccounts.id, account.id)));

    // While the account still needs reconnecting, retry is refused.
    await expect(postsService.retryTarget(env.scope, target.id)).rejects.toThrow(/Reconnect the account/);

    loginReturns([{ id: "100", name: "Acme", token: "NEW-PAGE-TOKEN" }]);
    const second = await signIn(env, session);
    await connect.chooseConnectCandidates(env.scope, { attemptId: second, selected: ["facebook:100"] }, session);

    await postsService.retryTarget(env.scope, target.id);
    const [row] = await testDb().select().from(postTargets).where(and(eq(postTargets.projectId, env.project.id), eq(postTargets.id, target.id)));
    expect(row).toMatchObject({ status: "scheduled", attemptCount: 0, lastError: null });
    expect(row?.nextAttemptAt).toBeInstanceOf(Date);
  });

  it("leaves the account needs_reauth when the login no longer manages the Page", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    loginReturns([{ id: "100", name: "Acme", token: "OLD-PAGE-TOKEN" }]);
    const first = await signIn(env, session);
    await connect.chooseConnectCandidates(env.scope, { attemptId: first, selected: ["facebook:100"] }, session);
    const before = await rowFor("100", env.project.id);
    await testDb().update(socialAccounts).set({ status: "needs_reauth", lastError: "revoked" }).where(and(eq(socialAccounts.projectId, env.project.id), eq(socialAccounts.id, before.id)));

    loginReturns([{ id: "200", name: "Other Page", token: "OTHER-TOKEN" }]);
    const second = await signIn(env, session);
    const choice = await connect.getConnectChoice(env.scope, second, session);
    expect(choice?.candidates.map((c) => c.key)).toEqual(["facebook:200"]);
    expect(choice?.missing).toEqual([{ accountId: before.id, displayName: "Acme", providerName: "Facebook" }]);
    await connect.chooseConnectCandidates(env.scope, { attemptId: second, selected: ["facebook:200"] }, session);

    const after = await rowFor("100", env.project.id);
    expect(after).toMatchObject({ status: "needs_reauth", lastError: "revoked" });
    expect(after.credentialsEncrypted).toEqual(before.credentialsEncrypted);
  });
});
