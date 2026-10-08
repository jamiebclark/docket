import { and, eq } from "drizzle-orm";
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
import { createFakeTikTok, creatorReply, tokenReply } from "../../helpers/fake-tiktok";
import { sessionFor } from "../../helpers/connect-group";
import { postsEnv } from "../../helpers/posts-env";

const fake = createFakeTikTok();
const CLIENT_SECRET = "tiktok-client-secret-value-0000";
const REDIRECT = "https://docket.local:3000/connect/callback";
const TOKEN = "/v2/oauth/token/";
const CREATOR = "/v2/post/publish/creator_info/query/";
const DAY_MS = 24 * 3600 * 1000;

afterAll(closeDb);
beforeEach(() => {
  vi.stubEnv("TIKTOK_CLIENT_KEY", "tiktok-client-key");
  vi.stubEnv("TIKTOK_CLIENT_SECRET", CLIENT_SECRET);
  vi.stubEnv("TIKTOK_APP_AUDITED", "false");
  fake.reset();
  fake.install();
});
afterEach(() => {
  fake.uninstall();
  vi.unstubAllEnvs();
});

type Env = Awaited<ReturnType<typeof postsEnv>>;
type Session = { sessionId: string };

function tiktokReplies(opts: { access?: string; refresh?: string; scope?: string } = {}) {
  fake.on("POST", TOKEN, {
    kind: "ok",
    body: tokenReply({ access_token: opts.access ?? "ACCESS-1", refresh_token: opts.refresh ?? "REFRESH-1", ...(opts.scope ? { scope: opts.scope } : {}) }),
  });
  fake.on("POST", CREATOR, { kind: "ok", body: creatorReply() });
}

async function start(env: Env, session: Session) {
  const { url } = await connect.startOAuthConnect(env.scope, { groupKey: "tiktok" }, session);
  return { url, state: new URL(url).searchParams.get("state")! };
}

const OK_SCOPES = "user.info.basic,video.publish";

async function land(env: Env, session: Session, extra: Record<string, string> = { code: "CODE1234", scopes: OK_SCOPES }) {
  const { state } = await start(env, session);
  const out = await connect.handleOAuthCallback(new URLSearchParams({ state, ...extra }), { userId: env.owner.id, sessionId: session.sessionId });
  return { out, state };
}

const rows = (projectId: string) => testDb().select().from(socialAccounts).where(eq(socialAccounts.projectId, projectId));

describe("starting a TikTok connection", () => {
  it("redirects to the TikTok authorize URL with the fixed HTTPS callback and no PKCE", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    const { url, state } = await start(env, session);
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://www.tiktok.com/v2/auth/authorize/");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_key: "tiktok-client-key",
      response_type: "code",
      scope: "user.info.basic,video.publish",
      redirect_uri: REDIRECT,
      state,
    });
    expect(url).not.toContain(CLIENT_SECRET);
    const group = (await connect.listConnectGroups(env.scope)).find((g) => g.key === "tiktok");
    expect(group).toMatchObject({ configured: true, available: true, unavailable: null, providerKeys: ["tiktok"] });
  });

  it("is not configured, and so not available to start, without the variables", async () => {
    vi.stubEnv("TIKTOK_CLIENT_KEY", "");
    vi.stubEnv("TIKTOK_CLIENT_SECRET", "");
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    const group = (await connect.listConnectGroups(env.scope)).find((g) => g.key === "tiktok");
    expect(group?.configured ?? false).toBe(false);
    await expect(start(env, session)).rejects.toThrow();
  });
});

describe("the callback and chooser", () => {
  it("exchanges the code as a form body, offers the creator and saves encrypted credentials", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    tiktokReplies();
    const { out } = await land(env, session);
    if (out.kind !== "chooser") throw new Error(`expected chooser, got ${JSON.stringify(out)}`);

    const [token, creator] = fake.requests;
    expect(token).toMatchObject({ method: "POST", path: TOKEN, host: "open.tiktokapis.com", auth: "none" });
    expect(token!.contentType).toBe("application/x-www-form-urlencoded");
    expect(token!.fields).toEqual({
      client_key: "tiktok-client-key",
      client_secret: CLIENT_SECRET,
      code: "CODE1234",
      grant_type: "authorization_code",
      redirect_uri: REDIRECT,
    });
    expect(creator).toMatchObject({ path: CREATOR, auth: "bearer" });

    const choice = await connect.getConnectChoice(env.scope, out.attemptId, session);
    expect(choice?.candidates).toHaveLength(1);
    expect(choice?.candidates[0]).toMatchObject({ key: "tiktok:open-id-1", displayName: "Ada (@ada)", state: "new" });
    const chooserText = JSON.stringify(choice);
    for (const secret of ["ACCESS-1", "REFRESH-1", CLIENT_SECRET]) expect(chooserText).not.toContain(secret);

    expect(await rows(env.project.id)).toHaveLength(0);
    const r = await connect.chooseConnectCandidates(env.scope, { attemptId: out.attemptId, selected: ["tiktok:open-id-1"] }, session);
    expect(r.ok && r.saved.map((a) => a.providerKey)).toEqual(["tiktok"]);

    const [row] = await rows(env.project.id);
    expect(row).toMatchObject({ providerKey: "tiktok", externalAccountId: "open-id-1", displayName: "Ada (@ada)", status: "active" });
    expect(row!.settings).toEqual({ username: "ada", nickname: "Ada" });
    const creds = decryptCredentials(row!.id, row!.credentialsEncrypted) as Record<string, number | string>;
    expect(creds).toMatchObject({ v: 1, accessToken: "ACCESS-1", refreshToken: "REFRESH-1", openId: "open-id-1" });
    const expiry = row!.credentialsExpiresAt!.getTime();
    expect(expiry).toBe(creds.refreshExpiresAt);
    expect(expiry).toBeGreaterThan(Date.now() + 364 * DAY_MS);
    expect(JSON.stringify(row)).not.toContain("ACCESS-1");
    expect(JSON.stringify(row)).not.toContain("REFRESH-1");
  });

  it("shows the unaudited note on the saved account's card, and not once audited", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    tiktokReplies();
    const { out } = await land(env, session);
    if (out.kind !== "chooser") throw new Error("expected chooser");
    await connect.chooseConnectCandidates(env.scope, { attemptId: out.attemptId, selected: ["tiktok:open-id-1"] }, session);

    const notes = async () => (await listAccounts(env.scope)).find((a) => a.providerKey === "tiktok")?.notes ?? [];
    expect((await notes()).some((n) => n.startsWith("Private posts only"))).toBe(true);
    expect(await notes()).toContain("Photo posts need your media domain verified in your TikTok app.");
    vi.stubEnv("TIKTOK_APP_AUDITED", "true");
    expect((await notes()).some((n) => n.startsWith("Private posts only"))).toBe(false);
  });

  it("refuses callback scopes without video.publish before any token call", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    tiktokReplies();
    const { out } = await land(env, session, { code: "CODE1234", scopes: "user.info.basic" });
    expect(out).toMatchObject({ kind: "accounts", groupKey: "tiktok", code: "exchange_failed" });
    expect(fake.requests).toHaveLength(0);
    expect(await rows(env.project.id)).toHaveLength(0);
  });

  it("treats access_denied as cancelled and other errors as platform errors, changing nothing", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    expect((await land(env, session, { error: "access_denied" })).out).toMatchObject({ kind: "accounts", groupKey: "tiktok", code: "cancelled" });
    expect((await land(env, session, { error: "server_error" })).out).toMatchObject({ kind: "accounts", code: "platform_error" });
    expect(await rows(env.project.id)).toHaveLength(0);
    expect(fake.requests).toHaveLength(0);
  });

  it.each([
    ["token exchange", () => fake.on("POST", TOKEN, { kind: "oauth_error", status: 400, error: "invalid_grant" })],
    ["unreadable token reply", () => fake.on("POST", TOKEN, { kind: "ok", body: tokenReply({ open_id: undefined }) })],
    ["creator info", () => fake.on("POST", CREATOR, { kind: "http", status: 503 })],
    ["missing post permission", () => fake.on("POST", CREATOR, { kind: "error", status: 403, code: "scope_not_authorized" })],
  ])("a %s failure saves nothing and leaks no token", async (_name, fail) => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    tiktokReplies();
    fail();
    const { out } = await land(env, session);
    expect(out).toMatchObject({ kind: "accounts", groupKey: "tiktok", code: "exchange_failed" });
    expect(JSON.stringify(out)).not.toContain("ACCESS-1");
    expect(await rows(env.project.id)).toHaveLength(0);
  });
});

describe("reconnecting", () => {
  it("restores a needs_reauth account in place with the new tokens", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    tiktokReplies({ access: "OLD-ACCESS", refresh: "OLD-REFRESH" });
    const first = (await land(env, session)).out;
    if (first.kind !== "chooser") throw new Error("expected chooser");
    await connect.chooseConnectCandidates(env.scope, { attemptId: first.attemptId, selected: ["tiktok:open-id-1"] }, session);
    const [before] = await rows(env.project.id);
    await testDb()
      .update(socialAccounts)
      .set({ status: "needs_reauth", lastError: "TikTok refused to renew the sign-in (invalid_grant). Reconnect the account." })
      .where(and(eq(socialAccounts.projectId, env.project.id), eq(socialAccounts.id, before!.id)));

    tiktokReplies({ access: "NEW-ACCESS", refresh: "NEW-REFRESH" });
    const { out } = await land(env, session);
    if (out.kind !== "chooser") throw new Error("expected chooser");
    expect((await connect.getConnectChoice(env.scope, out.attemptId, session))?.candidates[0]).toMatchObject({ state: "needs_reauth" });
    const r = await connect.chooseConnectCandidates(env.scope, { attemptId: out.attemptId, selected: ["tiktok:open-id-1"] }, session);
    expect(r.ok && r.saved[0]).toMatchObject({ id: before!.id, status: "active", lastError: null });

    const all = await rows(env.project.id);
    expect(all).toHaveLength(1);
    expect(decryptCredentials(all[0]!.id, all[0]!.credentialsEncrypted)).toMatchObject({ accessToken: "NEW-ACCESS", refreshToken: "NEW-REFRESH" });
  });
});
