import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The cached app environment reads this once; the connect callback address must be public HTTPS.
vi.hoisted(() => {
  process.env.BETTER_AUTH_URL = "https://docket.local:3000";
});
vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);
vi.mock("next/cache", async () => (await import("../../helpers/actions")).cacheModule);
vi.mock("next/navigation", async () => (await import("../../helpers/actions")).navigationModule);

import { socialAccounts } from "../../../src/server/db/schema/accounts";
import { decryptCredentials, listAccounts } from "../../../src/server/services/accounts";
import * as connect from "../../../src/server/services/connect";
import { closeDb, testDb } from "../../helpers/db";
import { createFakePinterest, tokenReply, userAccountReply } from "../../helpers/fake-pinterest";
import { sessionFor } from "../../helpers/connect-group";
import { postsEnv } from "../../helpers/posts-env";

const fake = createFakePinterest();
const CLIENT_SECRET = "pinterest-client-secret-value-0";
const REDIRECT = "https://docket.local:3000/connect/callback";
const TOKEN = "/v5/oauth/token";
const USER_ACCOUNT = "/v5/user_account";
const DAY_MS = 24 * 3600 * 1000;

afterAll(closeDb);
beforeEach(() => {
  vi.stubEnv("PINTEREST_CLIENT_ID", "pinterest-client-id");
  vi.stubEnv("PINTEREST_CLIENT_SECRET", CLIENT_SECRET);
  fake.reset();
  fake.install();
});
afterEach(() => {
  fake.uninstall();
  vi.unstubAllEnvs();
});

type Env = Awaited<ReturnType<typeof postsEnv>>;
type Session = { sessionId: string };

function pinterestReplies(opts: { access?: string; refresh?: string } = {}) {
  fake.on("POST", TOKEN, { kind: "ok", body: tokenReply({ access_token: opts.access ?? "ACCESS-1", refresh_token: opts.refresh ?? "REFRESH-1" }) });
  fake.on("GET", USER_ACCOUNT, { kind: "ok", body: userAccountReply() });
}

async function start(env: Env, session: Session) {
  const { url } = await connect.startOAuthConnect(env.scope, { groupKey: "pinterest" }, session);
  return { url, state: new URL(url).searchParams.get("state")! };
}

async function land(env: Env, session: Session, extra: Record<string, string> = { code: "CODE1234" }) {
  const { state } = await start(env, session);
  const out = await connect.handleOAuthCallback(new URLSearchParams({ state, ...extra }), { userId: env.owner.id, sessionId: session.sessionId });
  return { out, state };
}

const rows = (projectId: string) => testDb().select().from(socialAccounts).where(eq(socialAccounts.projectId, projectId));

describe("starting a Pinterest connection", () => {
  it("redirects to Pinterest's authorize URL with the fixed HTTPS callback and no code_challenge", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    const { url, state } = await start(env, session);
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://www.pinterest.com/oauth/");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: "pinterest-client-id",
      response_type: "code",
      scope: "user_accounts:read,boards:read,pins:write",
      redirect_uri: REDIRECT,
      state,
    });
    expect(url).not.toContain(CLIENT_SECRET);
    const group = (await connect.listConnectGroups(env.scope)).find((g) => g.key === "pinterest");
    expect(group).toMatchObject({ configured: true, available: true, unavailable: null, providerKeys: ["pinterest"] });
  });

  it("is not configured, and so not available to start, without the variables", async () => {
    vi.stubEnv("PINTEREST_CLIENT_ID", "");
    vi.stubEnv("PINTEREST_CLIENT_SECRET", "");
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    const group = (await connect.listConnectGroups(env.scope)).find((g) => g.key === "pinterest");
    expect(group?.configured ?? false).toBe(false);
    await expect(start(env, session)).rejects.toThrow();
  });
});

describe("the callback and chooser", () => {
  it("exchanges the code with Basic auth, reads the account and saves encrypted credentials", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    pinterestReplies();
    const { out } = await land(env, session);
    if (out.kind !== "chooser") throw new Error(`expected chooser, got ${JSON.stringify(out)}`);

    const [token, account] = fake.requests;
    expect(token).toMatchObject({ method: "POST", path: TOKEN, host: "api.pinterest.com", auth: "basic" });
    expect(token!.contentType).toBe("application/x-www-form-urlencoded");
    expect(token!.fields).toEqual({ code: "CODE1234", grant_type: "authorization_code", redirect_uri: REDIRECT });
    expect(account).toMatchObject({ path: USER_ACCOUNT, auth: "bearer" });

    const choice = await connect.getConnectChoice(env.scope, out.attemptId, session);
    expect(choice?.candidates).toHaveLength(1);
    expect(choice?.candidates[0]).toMatchObject({ key: "pinterest:pinterest-user-1", displayName: "Ada's Studio", state: "new" });
    const chooserText = JSON.stringify(choice);
    for (const secret of ["ACCESS-1", "REFRESH-1", CLIENT_SECRET]) expect(chooserText).not.toContain(secret);

    expect(await rows(env.project.id)).toHaveLength(0);
    const r = await connect.chooseConnectCandidates(env.scope, { attemptId: out.attemptId, selected: ["pinterest:pinterest-user-1"] }, session);
    expect(r.ok && r.saved.map((a) => a.providerKey)).toEqual(["pinterest"]);

    const [row] = await rows(env.project.id);
    expect(row).toMatchObject({ providerKey: "pinterest", externalAccountId: "pinterest-user-1", displayName: "Ada's Studio", status: "active" });
    expect(row!.settings).toEqual({});
    const creds = decryptCredentials(row!.id, row!.credentialsEncrypted) as Record<string, number | string>;
    expect(creds).toMatchObject({ v: 1, accessToken: "ACCESS-1", refreshToken: "REFRESH-1" });
    const expiry = row!.credentialsExpiresAt!.getTime();
    expect(expiry).toBe(creds.refreshExpiresAt);
    expect(expiry).toBeGreaterThan(Date.now() + 59 * DAY_MS);
    expect(JSON.stringify(row)).not.toContain("ACCESS-1");
    expect(JSON.stringify(row)).not.toContain("REFRESH-1");
  });

  it("falls back to the username when business_name is absent", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    fake.on("POST", TOKEN, { kind: "ok", body: tokenReply() });
    fake.on("GET", USER_ACCOUNT, { kind: "ok", body: userAccountReply({ business_name: undefined }) });
    const { out } = await land(env, session);
    if (out.kind !== "chooser") throw new Error("expected chooser");
    const choice = await connect.getConnectChoice(env.scope, out.attemptId, session);
    expect(choice?.candidates[0]).toMatchObject({ displayName: "ada" });
  });

  it("shows the Trial note on the saved account's card", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    pinterestReplies();
    const { out } = await land(env, session);
    if (out.kind !== "chooser") throw new Error("expected chooser");
    await connect.chooseConnectCandidates(env.scope, { attemptId: out.attemptId, selected: ["pinterest:pinterest-user-1"] }, session);
    const notes = (await listAccounts(env.scope)).find((a) => a.providerKey === "pinterest")?.notes ?? [];
    expect(notes.some((n) => n.includes("Trial access"))).toBe(true);
  });

  it("treats access_denied as cancelled and other errors as platform errors, changing nothing, echoing none of the query", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    expect((await land(env, session, { error: "access_denied", error_description: "<script>evil</script>" })).out).toMatchObject({
      kind: "accounts",
      groupKey: "pinterest",
      code: "cancelled",
    });
    const second = (await land(env, session, { error: "server_error", error_description: "<script>evil</script>" })).out;
    expect(second).toMatchObject({ kind: "accounts", code: "platform_error" });
    expect(JSON.stringify(second)).not.toContain("script");
    expect(await rows(env.project.id)).toHaveLength(0);
    expect(fake.requests).toHaveLength(0);
  });

  it.each([
    ["token exchange", () => fake.on("POST", TOKEN, { kind: "oauth_error", status: 400, error: "invalid_grant" })],
    ["unreadable token reply", () => fake.on("POST", TOKEN, { kind: "ok", body: tokenReply({ refresh_token: undefined }) })],
    ["user account read", () => fake.on("GET", USER_ACCOUNT, { kind: "http", status: 503 })],
    ["user account with no usable id", () => fake.on("GET", USER_ACCOUNT, { kind: "ok", body: { username: "no-id" } })],
  ])("a %s failure saves nothing and leaks no token", async (_name, fail) => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    pinterestReplies();
    fail();
    const { out } = await land(env, session);
    expect(out).toMatchObject({ kind: "accounts", groupKey: "pinterest", code: "exchange_failed" });
    expect(JSON.stringify(out)).not.toContain("ACCESS-1");
    expect(await rows(env.project.id)).toHaveLength(0);
  });
});
