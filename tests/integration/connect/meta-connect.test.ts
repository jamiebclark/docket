import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { socialAccounts } from "../../../src/server/db/schema/accounts";
import { decryptCredentials } from "../../../src/server/services/accounts";
import * as connect from "../../../src/server/services/connect";
import { closeDb, testDb } from "../../helpers/db";
import { createFakeGraph } from "../../helpers/fake-graph";
import { sessionFor } from "../../helpers/connect-group";
import { postsEnv } from "../../helpers/posts-env";

// The real meta group, the real registered facebook/instagram providers, and a fake Graph.
const fake = createFakeGraph();
const APP_SECRET = "app-secret-value-0000";

afterAll(closeDb);
beforeEach(() => {
  vi.stubEnv("META_APP_ID", "12345");
  vi.stubEnv("META_APP_SECRET", APP_SECRET);
  vi.stubEnv("META_GRAPH_VERSION", "v26.0");
  fake.reset();
  fake.install();
});
afterEach(() => {
  fake.uninstall();
  vi.unstubAllEnvs();
});

describe("connecting through the meta group", () => {
  it("start -> callback -> chooser creates a Facebook and an Instagram account", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    fake.on("GET", "/v26.0/oauth/access_token", [
      { kind: "ok", body: { access_token: "user-token-short" } },
      { kind: "ok", body: { access_token: "user-token-long" } },
    ]);
    fake.on("GET", "/v26.0/me/accounts", {
      kind: "ok",
      body: { data: [{ id: "100", name: "Acme", access_token: "PAGE-TOKEN-100", instagram_business_account: { id: "1784" } }] },
    });

    const { url } = await connect.startOAuthConnect(env.scope, { groupKey: "meta" }, session);
    const dialog = new URL(url);
    expect(dialog.searchParams.get("client_id")).toBe("12345");
    expect(url).not.toContain(APP_SECRET);
    const state = dialog.searchParams.get("state")!;

    const out = await connect.handleOAuthCallback(new URLSearchParams({ state, code: "CODE" }), {
      userId: env.owner.id,
      sessionId: session.sessionId,
    });
    if (out.kind !== "chooser") throw new Error(`expected chooser, got ${JSON.stringify(out)}`);

    // Exchanges happened server-side, with the app secret, and the Page listing used the long-lived token.
    const exchanges = fake.requests.filter((r) => r.path === "/v26.0/oauth/access_token");
    expect(exchanges).toHaveLength(2);
    expect(exchanges.every((r) => r.params.client_secret === APP_SECRET)).toBe(true);
    expect(exchanges[0]!.params.code).toBe("CODE");
    expect(exchanges[1]!.params.grant_type).toBe("fb_exchange_token");

    const choice = await connect.getConnectChoice(env.scope, out.attemptId, session);
    expect(choice?.candidates.map((c) => c.key)).toEqual(["facebook:100", "instagram:1784"]);
    expect(JSON.stringify(choice)).not.toContain("PAGE-TOKEN");

    const r = await connect.chooseConnectCandidates(
      env.scope,
      { attemptId: out.attemptId, selected: ["facebook:100", "instagram:1784"] },
      session,
    );
    expect(r.ok && r.saved.map((a) => a.providerKey).sort()).toEqual(["facebook", "instagram"]);

    const rows = await testDb().select().from(socialAccounts).where(eq(socialAccounts.projectId, env.project.id));
    expect(rows.map((x) => `${x.providerKey}:${x.externalAccountId}`).sort()).toEqual(["facebook:100", "instagram:1784"]);
    for (const row of rows) {
      expect(decryptCredentials(row.id, row.credentialsEncrypted)).toEqual({ pageToken: "PAGE-TOKEN-100" });
    }
  });

  it("a login that lists no Pages lands on no_candidates, not exchange_failed (F1)", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    fake.on("GET", "/v26.0/oauth/access_token", [
      { kind: "ok", body: { access_token: "user-token-short" } },
      { kind: "ok", body: { access_token: "user-token-long" } },
    ]);
    fake.on("GET", "/v26.0/me/accounts", { kind: "ok", body: { data: [] } });
    const { url } = await connect.startOAuthConnect(env.scope, { groupKey: "meta" }, session);
    const state = new URL(url).searchParams.get("state")!;
    const out = await connect.handleOAuthCallback(new URLSearchParams({ state, code: "CODE" }), {
      userId: env.owner.id,
      sessionId: session.sessionId,
    });
    expect(JSON.stringify(out)).toContain("no_candidates");
    expect(JSON.stringify(out)).not.toContain("exchange_failed");
  });

  it("reports Meta as not configured, so no connect action is offered", async () => {
    vi.stubEnv("META_APP_ID", "");
    vi.stubEnv("META_APP_SECRET", "");
    const env = await postsEnv();
    const groups = await connect.listConnectGroups(env.scope);
    const meta = groups.find((g) => g.key === "meta");
    expect(meta).toMatchObject({ configured: false, providerKeys: ["facebook", "instagram"] });
  });
});
