import { renderToStaticMarkup } from "react-dom/server";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The cached app environment reads this once; the connect callback address must be public HTTPS.
vi.hoisted(() => {
  process.env.BETTER_AUTH_URL = "https://docket.local:3000";
});
vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);
vi.mock("next/cache", async () => (await import("../../helpers/actions")).cacheModule);
vi.mock("next/navigation", async () => (await import("../../helpers/actions")).navigationModule);

import AccountsPage from "../../../src/app/p/[projectSlug]/accounts/page";
import { redirectUriProblem } from "../../../src/providers/connect";
import { threadsConnectGroup } from "../../../src/providers/threads/connect-group";
import { socialAccounts } from "../../../src/server/db/schema/accounts";
import { connectAttempts } from "../../../src/server/db/schema";
import { ForbiddenError } from "../../../src/server/dal/errors";
import { providerEnvIssues } from "../../../src/server/provider-env";
import { decryptCredentials } from "../../../src/server/services/accounts";
import * as connect from "../../../src/server/services/connect";
import { closeDb, testDb } from "../../helpers/db";
import { createFakeGraph } from "../../helpers/fake-graph";
import { sessionFor } from "../../helpers/connect-group";
import { postsEnv } from "../../helpers/posts-env";

const fake = createFakeGraph();
const APP_SECRET = "threads-secret-value-0000";
const REDIRECT = "https://docket.local:3000/connect/callback";
const SIXTY_DAYS_MS = 60 * 24 * 3600 * 1000;

afterAll(closeDb);
beforeEach(() => {
  vi.stubEnv("THREADS_APP_ID", "424242");
  vi.stubEnv("THREADS_APP_SECRET", APP_SECRET);
  vi.stubEnv("THREADS_GRAPH_BASE", "https://graph.threads.test");
  fake.reset();
  fake.install();
});
afterEach(() => {
  fake.uninstall();
  vi.unstubAllEnvs();
});

type Env = Awaited<ReturnType<typeof postsEnv>>;

function threadsReplies(opts: { token?: string; granted?: string; username?: string | null; id?: string } = {}) {
  fake.on("POST", "/oauth/access_token", {
    kind: "ok",
    body: { access_token: "SHORT-TOKEN", ...(opts.granted !== undefined ? { permissions: opts.granted } : {}) },
  });
  fake.on("GET", "/access_token", { kind: "ok", body: { access_token: opts.token ?? "LONG-TOKEN", expires_in: 5_184_000 } });
  fake.on("GET", "/v1.0/me", {
    kind: "ok",
    body: { id: opts.id ?? "9001", ...(opts.username === null ? {} : { username: opts.username ?? "docket" }) },
  });
}

async function start(env: Env, session: { sessionId: string }) {
  const { url } = await connect.startOAuthConnect(env.scope, { groupKey: "threads" }, session);
  return { url, state: new URL(url).searchParams.get("state")! };
}

async function land(env: Env, session: { sessionId: string }, extra: Record<string, string> = { code: "CODE1234" }) {
  const { state } = await start(env, session);
  return connect.handleOAuthCallback(new URLSearchParams({ state, ...extra }), {
    userId: env.owner.id,
    sessionId: session.sessionId,
  });
}

async function rows(projectId: string) {
  return testDb().select().from(socialAccounts).where(eq(socialAccounts.projectId, projectId));
}

async function connected(env: Env, session: { sessionId: string }) {
  const out = await land(env, session);
  if (out.kind !== "chooser") throw new Error(`expected chooser, got ${JSON.stringify(out)}`);
  const r = await connect.chooseConnectCandidates(env.scope, { attemptId: out.attemptId, selected: ["threads:9001"] }, session);
  if (!r.ok) throw new Error("choose failed");
  return out.attemptId;
}

describe("starting a Threads connection", () => {
  it("redirects to the Threads authorize host with client id, scopes, state and the fixed HTTPS callback", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    const { url, state } = await start(env, session);
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://threads.com/oauth/authorize");
    expect(u.searchParams.get("client_id")).toBe("424242");
    expect(u.searchParams.get("scope")).toBe("threads_basic,threads_content_publish");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(state.length).toBeGreaterThan(20);
    expect(url).not.toContain(APP_SECRET);
    const group = (await connect.listConnectGroups(env.scope)).find((g) => g.key === "threads");
    expect(group).toMatchObject({ configured: true, available: true, unavailable: null });
  });

  it("refuses http: and localhost callback addresses (G10)", () => {
    for (const bad of ["http://docket.local:3000/connect/callback", "https://localhost:3000/connect/callback", "https://127.0.0.1/connect/callback"]) {
      expect(redirectUriProblem(threadsConnectGroup, bad)).toBe("Threads needs an HTTPS address that is not localhost.");
    }
    expect(redirectUriProblem(threadsConnectGroup, REDIRECT)).toBeNull();
  });

  it("refuses an editor", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.editor.id);
    const before = await testDb().select().from(connectAttempts).where(eq(connectAttempts.projectId, env.project.id));
    await expect(connect.startOAuthConnect(await env.as(env.editor), { groupKey: "threads" }, session)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await testDb().select().from(connectAttempts).where(eq(connectAttempts.projectId, env.project.id))).toHaveLength(before.length);
  });
});

describe("the callback and chooser", () => {
  it("exchanges server-side, offers one candidate and saves only the long-lived token", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    threadsReplies();
    const before = Date.now();
    const out = await land(env, session);
    if (out.kind !== "chooser") throw new Error(`expected chooser, got ${JSON.stringify(out)}`);

    const [code, long, me] = fake.requests;
    expect(code).toMatchObject({ method: "POST", path: "/oauth/access_token", host: "graph.threads.test" });
    expect(code!.params).toMatchObject({ client_secret: APP_SECRET, code: "CODE1234", grant_type: "authorization_code", redirect_uri: REDIRECT });
    expect(long!.params.grant_type).toBe("th_exchange_token");
    expect(me!.path).toBe("/v1.0/me");

    const choice = await connect.getConnectChoice(env.scope, out.attemptId, session);
    expect(choice?.candidates).toHaveLength(1);
    expect(choice?.candidates[0]).toMatchObject({ key: "threads:9001", displayName: "@docket", state: "new", notes: [] });
    expect(JSON.stringify(choice)).not.toContain("LONG-TOKEN");

    expect(await rows(env.project.id)).toHaveLength(0);
    const r = await connect.chooseConnectCandidates(env.scope, { attemptId: out.attemptId, selected: ["threads:9001"] }, session);
    expect(r.ok && r.saved.map((a) => a.providerKey)).toEqual(["threads"]);

    const [row] = await rows(env.project.id);
    expect(row).toMatchObject({ providerKey: "threads", externalAccountId: "9001", displayName: "@docket", status: "active" });
    const creds = decryptCredentials(row!.id, row!.credentialsEncrypted) as Record<string, unknown>;
    expect(creds).toMatchObject({ v: 1, accessToken: "LONG-TOKEN", expiryEstimated: false });
    expect(Object.keys(creds).sort()).toEqual(["accessToken", "expiresAt", "expiryEstimated", "issuedAt", "v"]);
    expect(creds.expiresAt as number).toBeGreaterThanOrEqual(before + SIXTY_DAYS_MS);
    expect(creds.expiresAt as number).toBeLessThan(Date.now() + SIXTY_DAYS_MS + 1000);
    expect(row!.credentialsExpiresAt?.getTime()).toBe(creds.expiresAt);
    expect(JSON.stringify(row)).not.toContain("SHORT-TOKEN");
  });

  it("falls back to the id when Threads gives no username", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    threadsReplies({ username: null });
    const out = await land(env, session);
    if (out.kind !== "chooser") throw new Error("expected chooser");
    expect((await connect.getConnectChoice(env.scope, out.attemptId, session))?.candidates[0]?.displayName).toBe("9001");
  });

  it("notes a declined publishing permission in the chooser", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    threadsReplies({ granted: "threads_basic" });
    const out = await land(env, session);
    if (out.kind !== "chooser") throw new Error("expected chooser");
    expect((await connect.getConnectChoice(env.scope, out.attemptId, session))?.candidates[0]?.notes).toEqual([
      "Publishing permission was not granted. Connect again and allow it.",
    ]);
  });

  it.each([
    ["code exchange", () => fake.on("POST", "/oauth/access_token", { kind: "graph_error", code: 100, message: "bad code" })],
    ["long-lived exchange", () => fake.on("GET", "/access_token", { kind: "graph_error", code: 100, message: "nope" })],
    ["profile", () => fake.on("GET", "/v1.0/me", { kind: "graph_error", code: 190, message: "nope" })],
  ])("a %s failure creates and changes nothing", async (_name, fail) => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    threadsReplies();
    fail();
    const out = await land(env, session);
    expect(out).toMatchObject({ kind: "accounts", groupKey: "threads", code: "exchange_failed" });
    expect(await rows(env.project.id)).toHaveLength(0);
  });

  it("explains the failure in words that carry no secret", async () => {
    const result = await threadsConnectGroup.exchangeCode({
      code: "CODE1234",
      redirectUri: REDIRECT,
      now: new Date(),
      signal: new AbortController().signal,
    } as never);
    expect(result).toMatchObject({ ok: false }); // fake graph default is a 404 Graph error
    const text = JSON.stringify(result);
    expect(text).toContain("Check THREADS_APP_ID, THREADS_APP_SECRET");
    expect(text).not.toContain(APP_SECRET);
    expect(text).not.toContain("CODE1234");
  });

  it("says Threads could not be reached when the network fails", async () => {
    fake.on("POST", "/oauth/access_token", { kind: "pre_send_failure" });
    const result = await threadsConnectGroup.exchangeCode({
      code: "CODE1234",
      redirectUri: REDIRECT,
      now: new Date(),
      signal: new AbortController().signal,
    } as never);
    expect(result).toEqual({ ok: false, message: "Threads could not be reached. Nothing changed. Try again." });
  });

  it("maps cancel and access_denied to a plain cancelled outcome with no change", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    expect(await land(env, session, { error: "access_denied", error_reason: "user_denied" })).toMatchObject({ kind: "accounts", code: "cancelled" });
    expect(await land(env, session, { error: "server_error" })).toMatchObject({ kind: "accounts", code: "platform_error" });
    expect(await rows(env.project.id)).toHaveLength(0);
    expect(fake.requests).toHaveLength(0);
  });

  it("shows the tester-invite hint after a failed callback (G12)", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    const { sessionModule } = await import("../../helpers/actions");
    const original = sessionModule.getSession;
    sessionModule.getSession = (async () => ({ user: { id: env.owner.id }, session: { id: session.sessionId } })) as never;
    try {
      const html = renderToStaticMarkup(
        await AccountsPage({
          params: Promise.resolve({ projectSlug: env.project.slug }),
          searchParams: Promise.resolve({ connect: "exchange_failed", group: "threads" }),
        }),
      );
      expect(html).toContain("accepted the tester invite");
    } finally {
      sessionModule.getSession = original;
    }
  });
});

describe("reconnecting", () => {
  it("updates the same row in place and clears the error", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    threadsReplies({ token: "OLD-LONG" });
    await connected(env, session);
    const [before] = await rows(env.project.id);
    await testDb()
      .update(socialAccounts)
      .set({ status: "needs_reauth", lastError: "Threads says the access token is no longer valid." })
      .where(and(eq(socialAccounts.projectId, env.project.id), eq(socialAccounts.id, before!.id)));

    threadsReplies({ token: "NEW-LONG" });
    const out = await land(env, session);
    if (out.kind !== "chooser") throw new Error("expected chooser");
    expect((await connect.getConnectChoice(env.scope, out.attemptId, session))?.candidates[0]).toMatchObject({ state: "needs_reauth" });
    const r = await connect.chooseConnectCandidates(env.scope, { attemptId: out.attemptId, selected: ["threads:9001"] }, session);
    expect(r.ok && r.saved[0]).toMatchObject({ id: before!.id, status: "active", lastError: null });

    const all = await rows(env.project.id);
    expect(all).toHaveLength(1);
    expect(decryptCredentials(all[0]!.id, all[0]!.credentialsEncrypted)).toMatchObject({ accessToken: "NEW-LONG" });
  });

  it("says already connected for an active account", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.owner.id);
    threadsReplies();
    await connected(env, session);
    const out = await land(env, session);
    if (out.kind !== "chooser") throw new Error("expected chooser");
    expect((await connect.getConnectChoice(env.scope, out.attemptId, session))?.candidates[0]).toMatchObject({ state: "connected" });
  });
});

describe("authority", () => {
  it("refuses an editor on callback and choose", async () => {
    const env = await postsEnv();
    const ownerSession = await sessionFor(env.owner.id);
    const editorSession = await sessionFor(env.editor.id);
    threadsReplies();
    const { state } = await start(env, ownerSession);
    // The editor cannot redeem the owner's state.
    expect(await connect.handleOAuthCallback(new URLSearchParams({ state, code: "CODE1234" }), { userId: env.editor.id, sessionId: editorSession.sessionId })).toEqual({ kind: "invalid" });
    expect(fake.requests).toHaveLength(0);

    const out = await connect.handleOAuthCallback(new URLSearchParams({ state, code: "CODE1234" }), { userId: env.owner.id, sessionId: ownerSession.sessionId });
    if (out.kind !== "chooser") throw new Error("expected chooser");
    await expect(
      connect.chooseConnectCandidates(await env.as(env.editor), { attemptId: out.attemptId, selected: ["threads:9001"] }, editorSession),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await rows(env.project.id)).toHaveLength(0);
  });
});

describe("configuration", () => {
  it("hides the action when Threads is not configured, leaving Meta alone", async () => {
    vi.stubEnv("THREADS_APP_ID", "");
    vi.stubEnv("THREADS_APP_SECRET", "");
    vi.stubEnv("META_APP_ID", "12345");
    vi.stubEnv("META_APP_SECRET", "app-secret-value-0000");
    const env = await postsEnv();
    const groups = await connect.listConnectGroups(env.scope);
    expect(groups.find((g) => g.key === "threads")).toMatchObject({ configured: false, available: false, providerKeys: ["threads"] });
    expect(groups.find((g) => g.key === "meta")).toMatchObject({ configured: true, providerKeys: ["facebook", "instagram"] });
  });

  it("an app id without a secret is a startup error naming the variable only", () => {
    vi.stubEnv("THREADS_APP_SECRET", "");
    const issues = providerEnvIssues(process.env as Record<string, string | undefined>).filter((i) => i.name.startsWith("THREADS_"));
    expect(issues).toEqual([{ name: "THREADS_APP_SECRET", reason: "required when THREADS_APP_ID is set" }]);
    expect(JSON.stringify(issues)).not.toContain("424242");
  });
});
