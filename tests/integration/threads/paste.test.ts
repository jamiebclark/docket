import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.BETTER_AUTH_URL = "https://docket.local:3000";
});
vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);
vi.mock("next/cache", async () => (await import("../../helpers/actions")).cacheModule);
vi.mock("next/navigation", async () => (await import("../../helpers/actions")).navigationModule);

import { threadsAccountNotes } from "../../../src/providers/threads/settings";
import { socialAccounts } from "../../../src/server/db/schema/accounts";
import { ForbiddenError } from "../../../src/server/dal/errors";
import { decryptCredentials } from "../../../src/server/services/accounts";
import * as connect from "../../../src/server/services/connect";
import { closeDb, testDb } from "../../helpers/db";
import { createFakeGraph } from "../../helpers/fake-graph";
import { sessionFor } from "../../helpers/connect-group";
import { postsEnv } from "../../helpers/posts-env";

const fake = createFakeGraph();
const PASTED = "PASTED-THREADS-TOKEN-ABC";
const SIXTY_DAYS_MS = 60 * 24 * 3600 * 1000;
const UNREACHABLE = "Could not reach Threads to check that token. Nothing changed. Try again.";
const NOT_ACCEPTED = "That token was not accepted by Threads. Generate a new one for your tester account and paste it again.";
const refusal = { kind: "graph_error", code: 190, message: "Invalid OAuth access token" } as const;

afterAll(closeDb);
beforeEach(() => {
  vi.stubEnv("THREADS_APP_ID", "424242");
  vi.stubEnv("THREADS_APP_SECRET", "threads-secret-value-0000");
  vi.stubEnv("THREADS_GRAPH_BASE", "https://graph.threads.test");
  fake.reset();
  fake.install();
});
afterEach(() => {
  fake.uninstall();
  vi.unstubAllEnvs();
});

const me = { kind: "ok", body: { id: "9001", username: "docket" } } as const;

async function paste() {
  const env = await postsEnv();
  const session = await sessionFor(env.owner.id);
  const r = await connect.pasteConnectToken(env.scope, { groupKey: "threads", token: PASTED }, session);
  return { env, session, r };
}

async function saved(env: Awaited<ReturnType<typeof postsEnv>>, session: { sessionId: string }, attemptId: string) {
  const c = await connect.chooseConnectCandidates(env.scope, { attemptId, selected: ["threads:9001"] }, session);
  if (!c.ok) throw new Error("choose failed");
  const [row] = await testDb().select().from(socialAccounts).where(eq(socialAccounts.projectId, env.project.id));
  return { row: row!, creds: decryptCredentials(row!.id, row!.credentialsEncrypted) as Record<string, unknown> };
}

describe("pasting a Threads token", () => {
  it("(a) saves the long-lived token when the exchange works", async () => {
    fake.on("GET", "/access_token", { kind: "ok", body: { access_token: "LONG-A", expires_in: 5_184_000 } });
    fake.on("GET", "/v1.0/me", me);
    const { env, session, r } = await paste();
    if (!r.ok) throw new Error(r.message);
    expect(fake.requests.map((q) => q.path)).toEqual(["/access_token", "/v1.0/me"]);
    const { creds, row } = await saved(env, session, r.attemptId);
    expect(creds).toMatchObject({ accessToken: "LONG-A", expiryEstimated: false });
    expect(row.settings).toEqual({});
  });

  it("(b) renews when the exchange is refused", async () => {
    fake.on("GET", "/access_token", refusal);
    fake.on("GET", "/refresh_access_token", { kind: "ok", body: { access_token: "RENEWED-B", expires_in: 5_184_000 } });
    fake.on("GET", "/v1.0/me", me);
    const { env, session, r } = await paste();
    if (!r.ok) throw new Error(r.message);
    expect(fake.requests.map((q) => q.path)).toEqual(["/access_token", "/refresh_access_token", "/v1.0/me"]);
    const { creds } = await saved(env, session, r.attemptId);
    expect(creds).toMatchObject({ accessToken: "RENEWED-B", expiryEstimated: false });
  });

  it("(c) saves the pasted token as is, with an estimated expiry and an account note", async () => {
    fake.on("GET", "/access_token", refusal);
    fake.on("GET", "/refresh_access_token", refusal);
    fake.on("GET", "/v1.0/me", me);
    const before = Date.now();
    const { env, session, r } = await paste();
    if (!r.ok) throw new Error(r.message);
    // The chooser says the expiry is estimated before anything is saved (F2).
    const connect = await import("../../../src/server/services/connect");
    const choice = await connect.getConnectChoice(env.scope, r.attemptId, session);
    expect(JSON.stringify(choice?.candidates)).toContain("Expiry estimated");
    const { creds, row } = await saved(env, session, r.attemptId);
    expect(creds).toMatchObject({ accessToken: PASTED, expiryEstimated: true });
    expect(creds.expiresAt as number).toBeGreaterThanOrEqual(before + SIXTY_DAYS_MS);
    expect(creds.issuedAt as number).toBeGreaterThanOrEqual(before);
    const settings = row.settings as { estimatedExpiry: string };
    expect(Date.parse(settings.estimatedExpiry)).toBe(creds.expiresAt);
    const accounts = await (await import("../../../src/server/services/accounts")).listAccounts(env.scope);
    expect(accounts[0]!.notes).toEqual([expect.stringContaining("Expiry estimated")]);

    // A later renewal writes a new expiry, which clears the note.
    expect(threadsAccountNotes({ settings, credentialsExpireAt: new Date(creds.expiresAt as number) })).toHaveLength(1);
    expect(threadsAccountNotes({ settings, credentialsExpireAt: new Date((creds.expiresAt as number) + 1000) })).toEqual([]);
  });

  it("(d) says so and changes nothing when every stage is refused", async () => {
    fake.on("GET", "/access_token", refusal);
    fake.on("GET", "/refresh_access_token", refusal);
    fake.on("GET", "/v1.0/me", refusal);
    const { env, r } = await paste();
    expect(r).toEqual({ ok: false, message: NOT_ACCEPTED });
    expect(await testDb().select().from(socialAccounts).where(eq(socialAccounts.projectId, env.project.id))).toHaveLength(0);
  });

  it.each([
    ["exchange", { "/access_token": { kind: "http", status: 503 } }, 1],
    ["renewal", { "/access_token": refusal, "/refresh_access_token": { kind: "graph_error", code: 4, message: "rate" } }, 2],
    ["profile", { "/access_token": refusal, "/refresh_access_token": refusal, "/v1.0/me": { kind: "unparseable" } }, 3],
  ] as const)("(e) a transient failure at %s stops without falling through", async (_stage, scripts, count) => {
    for (const [path, reply] of Object.entries(scripts)) fake.on("GET", path, reply);
    const { r } = await paste();
    expect(r).toEqual({ ok: false, message: UNREACHABLE });
    expect(fake.requests).toHaveLength(count);
  });

  it("never echoes the pasted token", async () => {
    fake.on("GET", "/access_token", refusal);
    fake.on("GET", "/refresh_access_token", refusal);
    fake.on("GET", "/v1.0/me", { kind: "graph_error", code: 190, message: `Bad token ${PASTED}` });
    const { r } = await paste();
    expect(JSON.stringify(r)).not.toContain(PASTED);
    expect(JSON.stringify(fake.requests.map((q) => q.params))).not.toContain(PASTED);
  });

  it("refuses an editor on the server", async () => {
    const env = await postsEnv();
    const session = await sessionFor(env.editor.id);
    await expect(
      connect.pasteConnectToken(await env.as(env.editor), { groupKey: "threads", token: PASTED }, session),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(fake.requests).toHaveLength(0);
  });
});
