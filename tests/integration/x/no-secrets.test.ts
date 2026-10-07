import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.BETTER_AUTH_URL = "https://docket.local:3000";
});
vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);
vi.mock("next/cache", async () => (await import("../../helpers/actions")).cacheModule);
vi.mock("next/navigation", async () => (await import("../../helpers/actions")).navigationModule);

import { publishAttempts } from "../../../src/server/db/schema/attempts";
import { connectAttempts } from "../../../src/server/db/schema/connect";
import { socialAccounts } from "../../../src/server/db/schema/accounts";
import { postTargets } from "../../../src/server/db/schema/posts";
import { pkceVerifier } from "../../../src/providers/x/pkce";
import { runTick } from "../../../src/server/scheduler";
import { runTokenRefresh } from "../../../src/server/scheduler/token-refresh";
import * as connect from "../../../src/server/services/connect";
import { closeDb, testDb } from "../../helpers/db";
import { sessionFor } from "../../helpers/connect-group";
import { createFakeX, tokenReply } from "../../helpers/fake-x";
import { postsEnv } from "../../helpers/posts-env";
import { createDueTarget, parkAllDueTargets } from "../../helpers/scheduling";

const CONFIG = {
  timeBudgetMs: 30_000, maxItems: 10, leaseMs: 60_000, providerTimeoutMs: 5_000, maxAttempts: 5,
  backoffBaseMs: 1_000, backoffMaxMs: 60_000, maxPublishDurationMs: 3_600_000, refreshWindowMs: 72 * 3_600_000,
  refreshMaxAccounts: 1000, batchSize: 4,
};
const CLIENT_SECRET = "NS-CLIENT-SECRET-7788";
const CODE = "NS-CODE-5566";
const ACCESS1 = "NS-ACCESS-ONE-1234";
const REFRESH1 = "NS-REFRESH-ONE-1234";
const ACCESS2 = "NS-ACCESS-TWO-5678";
const REFRESH2 = "NS-REFRESH-TWO-5678";

const fake = createFakeX();
let logged: string[] = [];
const spies: Array<ReturnType<typeof vi.spyOn>> = [];

beforeEach(async () => {
  await parkAllDueTargets();
  vi.stubEnv("X_CLIENT_ID", "x-client-id");
  vi.stubEnv("X_CLIENT_SECRET", CLIENT_SECRET);
  fake.reset();
  fake.install();
  fake.secrets(CLIENT_SECRET, CODE, ACCESS1, REFRESH1, ACCESS2, REFRESH2);
  logged = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    spies.push(vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logged.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x, errorReplacer))).join(" "))));
  }
});
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
  fake.uninstall();
  vi.unstubAllEnvs();
});
afterAll(closeDb);

function errorReplacer(_k: string, v: unknown) {
  return v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v;
}

describe("X secrets never leave the encrypted column (SC-008)", () => {
  it("keeps tokens, client secret, code, state and verifier out of plaintext through connect, refresh and publish", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    const projectId = env.project.id;

    // Connect.
    fake.on("POST", "/2/oauth2/token", { kind: "ok", body: tokenReply({ access_token: ACCESS1, refresh_token: REFRESH1 }) });
    fake.on("GET", "/2/users/me", { kind: "ok", body: { data: { id: "9001", username: "dockettest", name: "Docket Test" } } });
    const { url } = await connect.startOAuthConnect(env.scope, { groupKey: "x" }, session);
    const state = new URL(url).searchParams.get("state")!;
    const verifier = pkceVerifier(state, CLIENT_SECRET);
    const out = await connect.handleOAuthCallback(new URLSearchParams({ state, code: CODE }), { userId: env.owner.id, sessionId: session.sessionId });
    if (out.kind !== "chooser") throw new Error(`expected chooser, got ${JSON.stringify(out)}`);
    const saved = await connect.chooseConnectCandidates(env.scope, { attemptId: out.attemptId, selected: ["x:9001"] }, session);
    if (!saved.ok) throw new Error("choose failed");
    const accountId = saved.saved[0]!.id;

    // Refresh: pull the account into the window and renew it.
    const now = new Date();
    await testDb().update(socialAccounts).set({ credentialsExpiresAt: new Date(now.getTime() + 3_600_000) }).where(and(eq(socialAccounts.projectId, projectId), eq(socialAccounts.id, accountId)));
    fake.on("POST", "/2/oauth2/token", { kind: "ok", body: tokenReply({ access_token: ACCESS2, refresh_token: REFRESH2 }) });
    await runTokenRefresh({ config: CONFIG, tickId: randomUUID(), startedAt: now });

    // Publish: one provider failure, then one success.
    await createDueTarget(projectId, accountId, { baseText: "no secrets here" });
    fake.on("POST", "/2/tweets", [{ kind: "http", status: 503, body: `upstream said ${ACCESS2}` }, { kind: "ok", status: 201, body: { data: { id: "77" } } }]);
    await runTick({ config: {} });
    await runTick({ config: {} });

    const dump = JSON.stringify([
      (await testDb().select().from(socialAccounts).where(eq(socialAccounts.projectId, projectId))).map(({ credentialsEncrypted: _c, ...rest }) => rest),
      await testDb().select().from(connectAttempts).where(eq(connectAttempts.projectId, projectId)),
      await testDb().select().from(publishAttempts).where(eq(publishAttempts.projectId, projectId)),
      await testDb().select().from(postTargets).where(eq(postTargets.projectId, projectId)),
    ]);
    const haystack = `${dump}\n${logged.join("\n")}`;
    expect(fake.callsTo("POST", "/2/tweets").length).toBeGreaterThan(0);
    for (const secret of [CLIENT_SECRET, CODE, ACCESS1, REFRESH1, ACCESS2, REFRESH2, state, verifier]) {
      expect(haystack, `leaked ${secret.slice(0, 8)}…`).not.toContain(secret);
    }
  });
});
