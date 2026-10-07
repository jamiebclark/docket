import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The cached app environment reads this once; the connect callback address must be public HTTPS.
vi.hoisted(() => {
  process.env.BETTER_AUTH_URL = "https://docket.local:3000";
});
vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);
vi.mock("next/cache", async () => (await import("../../helpers/actions")).cacheModule);
vi.mock("next/navigation", async () => (await import("../../helpers/actions")).navigationModule);

import { pkceChallenge, pkceVerifier } from "../../../src/providers/x/pkce";
import { socialAccounts } from "../../../src/server/db/schema/accounts";
import { decryptCredentials } from "../../../src/server/services/accounts";
import * as connect from "../../../src/server/services/connect";
import { closeDb, testDb } from "../../helpers/db";
import { createFakeX, tokenReply } from "../../helpers/fake-x";
import { sessionFor } from "../../helpers/connect-group";
import { postsEnv } from "../../helpers/posts-env";

const fake = createFakeX();
const CLIENT_SECRET = "x-client-secret-value-0000";
const REDIRECT = "https://docket.local:3000/connect/callback";
const DAY_MS = 24 * 3600 * 1000;

afterAll(closeDb);
beforeEach(() => {
  vi.stubEnv("X_CLIENT_ID", "x-client-id");
  vi.stubEnv("X_CLIENT_SECRET", CLIENT_SECRET);
  fake.reset();
  fake.install();
});
afterEach(() => {
  fake.uninstall();
  vi.unstubAllEnvs();
});

type Env = Awaited<ReturnType<typeof postsEnv>>;
type Session = { sessionId: string };

function xReplies(opts: { access?: string; refresh?: string } = {}) {
  fake.on("POST", "/2/oauth2/token", {
    kind: "ok",
    body: tokenReply({ access_token: opts.access ?? "ACCESS-1", refresh_token: opts.refresh ?? "REFRESH-1" }),
  });
  fake.on("GET", "/2/users/me", { kind: "ok", body: { data: { id: "9001", username: "dockettest", name: "Docket Test" } } });
}

async function start(env: Env, session: Session) {
  const { url } = await connect.startOAuthConnect(env.scope, { groupKey: "x" }, session);
  return { url, state: new URL(url).searchParams.get("state")! };
}

async function land(env: Env, session: Session, extra: Record<string, string> = { code: "CODE1234" }) {
  const { state } = await start(env, session);
  const out = await connect.handleOAuthCallback(new URLSearchParams({ state, ...extra }), { userId: env.owner.id, sessionId: session.sessionId });
  return { out, state };
}

const rows = (projectId: string) => testDb().select().from(socialAccounts).where(eq(socialAccounts.projectId, projectId));

async function connected(env: Env, session: Session) {
  const { out } = await land(env, session);
  if (out.kind !== "chooser") throw new Error(`expected chooser, got ${JSON.stringify(out)}`);
  const r = await connect.chooseConnectCandidates(env.scope, { attemptId: out.attemptId, selected: ["x:9001"] }, session);
  if (!r.ok) throw new Error("choose failed");
}

describe("starting an X connection", () => {
  it("redirects to the X authorize URL with PKCE and the fixed HTTPS callback", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    const { url, state } = await start(env, session);
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://x.com/i/oauth2/authorize");
    expect(u.searchParams.get("client_id")).toBe("x-client-id");
    expect(u.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(u.searchParams.get("scope")).toBe("tweet.read tweet.write users.read media.write offline.access");
    expect(u.searchParams.get("code_challenge")).toBe(pkceChallenge(pkceVerifier(state, CLIENT_SECRET)));
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url).not.toContain(CLIENT_SECRET);
    const group = (await connect.listConnectGroups(env.scope)).find((g) => g.key === "x");
    expect(group).toMatchObject({ configured: true, available: true, unavailable: null, providerKeys: ["x"] });
  });
});

describe("the callback and chooser", () => {
  it("exchanges with the derived verifier, offers @dockettest and saves encrypted credentials", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    xReplies();
    const before = Date.now();
    const { out, state } = await land(env, session);
    if (out.kind !== "chooser") throw new Error(`expected chooser, got ${JSON.stringify(out)}`);

    const [token, me] = fake.requests;
    expect(token).toMatchObject({ method: "POST", path: "/2/oauth2/token", host: "api.x.com", auth: "basic", basicUser: "x-client-id" });
    expect(token!.fields).toMatchObject({
      grant_type: "authorization_code",
      code: "CODE1234",
      redirect_uri: REDIRECT,
      code_verifier: pkceVerifier(state, CLIENT_SECRET),
    });
    expect(me).toMatchObject({ path: "/2/users/me", auth: "bearer" });

    const choice = await connect.getConnectChoice(env.scope, out.attemptId, session);
    expect(choice?.candidates).toHaveLength(1);
    expect(choice?.candidates[0]).toMatchObject({ key: "x:9001", displayName: "@dockettest", state: "new", notes: [] });
    expect(JSON.stringify(choice)).not.toContain("ACCESS-1");
    expect(JSON.stringify(choice)).not.toContain("REFRESH-1");

    expect(await rows(env.project.id)).toHaveLength(0);
    const r = await connect.chooseConnectCandidates(env.scope, { attemptId: out.attemptId, selected: ["x:9001"] }, session);
    expect(r.ok && r.saved.map((a) => a.providerKey)).toEqual(["x"]);

    const [row] = await rows(env.project.id);
    expect(row).toMatchObject({ providerKey: "x", externalAccountId: "9001", displayName: "@dockettest", status: "active" });
    expect(row!.settings).toEqual({ username: "dockettest", name: "Docket Test" });
    const creds = decryptCredentials(row!.id, row!.credentialsEncrypted) as Record<string, number | string>;
    expect(creds).toMatchObject({ v: 1, accessToken: "ACCESS-1", refreshToken: "REFRESH-1" });
    expect(Object.keys(creds).sort()).toEqual(["accessExpiresAt", "accessToken", "refreshIssuedAt", "refreshToken", "v"]);
    const expiry = row!.credentialsExpiresAt!.getTime();
    expect(expiry).toBe((creds.refreshIssuedAt as number) + 180 * DAY_MS);
    expect(expiry).toBeGreaterThanOrEqual(before + 180 * DAY_MS);
    expect(expiry).toBeLessThan(Date.now() + 180 * DAY_MS + 1000);
    expect(JSON.stringify(row)).not.toContain("ACCESS-1");
  });

  it("treats access_denied as cancelled and other errors as platform errors, changing nothing", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    expect((await land(env, session, { error: "access_denied" })).out).toMatchObject({ kind: "accounts", groupKey: "x", code: "cancelled" });
    expect((await land(env, session, { error: "server_error" })).out).toMatchObject({ kind: "accounts", code: "platform_error" });
    expect(await rows(env.project.id)).toHaveLength(0);
    expect(fake.requests).toHaveLength(0);
  });

  it.each([
    ["token exchange", () => fake.on("POST", "/2/oauth2/token", { kind: "oauth_error", status: 400, error: "invalid_grant" })],
    ["missing refresh token", () => fake.on("POST", "/2/oauth2/token", { kind: "ok", body: tokenReply({ refresh_token: undefined }) })],
    ["profile", () => fake.on("GET", "/2/users/me", { kind: "problem", status: 401, title: "Unauthorized" })],
  ])("a %s failure saves nothing", async (_name, fail) => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    xReplies();
    fail();
    const { out } = await land(env, session);
    expect(out).toMatchObject({ kind: "accounts", groupKey: "x", code: "exchange_failed" });
    expect(await rows(env.project.id)).toHaveLength(0);
  });
});

describe("reconnecting", () => {
  it("restores a needs_reauth account in place with new credentials", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    xReplies({ access: "OLD-ACCESS", refresh: "OLD-REFRESH" });
    await connected(env, session);
    const [before] = await rows(env.project.id);
    await testDb()
      .update(socialAccounts)
      .set({ status: "needs_reauth", lastError: "X no longer accepts this sign-in." })
      .where(and(eq(socialAccounts.projectId, env.project.id), eq(socialAccounts.id, before!.id)));

    xReplies({ access: "NEW-ACCESS", refresh: "NEW-REFRESH" });
    const { out } = await land(env, session);
    if (out.kind !== "chooser") throw new Error("expected chooser");
    expect((await connect.getConnectChoice(env.scope, out.attemptId, session))?.candidates[0]).toMatchObject({ state: "needs_reauth" });
    const r = await connect.chooseConnectCandidates(env.scope, { attemptId: out.attemptId, selected: ["x:9001"] }, session);
    expect(r.ok && r.saved[0]).toMatchObject({ id: before!.id, status: "active", lastError: null });

    const all = await rows(env.project.id);
    expect(all).toHaveLength(1);
    expect(decryptCredentials(all[0]!.id, all[0]!.credentialsEncrypted)).toMatchObject({ accessToken: "NEW-ACCESS", refreshToken: "NEW-REFRESH" });
  });
});
