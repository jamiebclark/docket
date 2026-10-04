import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCrossProject } from "../../src/server/db/cross-project";
import { socialAccounts } from "../../src/server/db/schema/accounts";
import { ConflictError, ForbiddenError, NotFoundError } from "../../src/server/dal/errors";
import * as accounts from "../../src/server/services/accounts";
import { closeDb, testDb } from "../helpers/db";
import { createFakePds, mintJwt, type FakePds } from "../helpers/fake-pds";
import { postsEnv } from "../helpers/posts-env";

afterAll(async () => {
  await closeDb();
});

const CREATE = "/xrpc/com.atproto.server.createSession";
const PASSWORD = "abcd-efgh-ijkl-mnop";
let pds: FakePds;
const logged: string[] = [];

beforeEach(() => {
  pds = createFakePds();
  vi.stubGlobal("fetch", pds.fetch);
  logged.length = 0;
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });
  }
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const session = (did = "did:plc:alice", handle = "alice.bsky.social") => ({
  accessJwt: mintJwt(new Date("2030-01-01T01:00:00Z")),
  refreshJwt: mintJwt(new Date("2030-03-01T00:00:00Z")),
  did,
  handle,
});
const input = (fields: Record<string, string> = {}, accountId?: string) => ({
  providerKey: "bluesky",
  fields: { handle: "Alice.bsky.social", appPassword: PASSWORD, pdsUrl: "", ...fields },
  ...(accountId ? { accountId } : {}),
});

async function flag(projectId: string, id: string, status: "active" | "needs_reauth", lastError: string | null) {
  await testDb().update(socialAccounts).set({ status, lastError }).where(and(eq(socialAccounts.projectId, projectId), eq(socialAccounts.id, id)));
}

async function rows(projectId: string) {
  return testDb().select().from(socialAccounts).where(and(eq(socialAccounts.projectId, projectId), eq(socialAccounts.providerKey, "bluesky")));
}

describe("connectWithCredentials", () => {
  it("connects with the default PDS and stores an encrypted session, never the app password", async () => {
    const env = await postsEnv();
    pds.route("POST", CREATE, { json: session() });
    const out = await accounts.connectWithCredentials(env.scope, input());
    expect(out).toMatchObject({ ok: true, account: { providerKey: "bluesky", displayName: "alice.bsky.social", status: "active" } });
    expect(pds.requests[0]!.url).toMatch(/^https:\/\/bsky\.social\//);

    const [row] = await rows(env.project.id);
    expect(row).toMatchObject({ externalAccountId: "did:plc:alice", settings: { pdsUrl: "https://bsky.social" }, status: "active" });
    expect(row!.credentialsExpiresAt).toEqual(new Date("2030-03-01T00:00:00Z"));
    const ciphertext = await env.scope.accounts.getCredentialsCiphertext(row!.id);
    expect(accounts.decryptCredentials(row!.id, ciphertext)).toMatchObject({ did: "did:plc:alice", handle: "alice.bsky.social" });

    const dump = await runCrossProject("test: scan social_accounts", async () => {
      const r = await testDb().execute<{ r: string }>(sql.raw(`select t::text as r from "social_accounts" t`));
      return r.rows.map((x) => x.r).join("\n");
    });
    expect(dump).not.toContain(PASSWORD);
    expect(JSON.stringify(out)).not.toContain(PASSWORD);
    expect(logged.join("\n")).not.toContain(PASSWORD);
  });

  it("sends the request to a custom PDS", async () => {
    const env = await postsEnv();
    pds.route("POST", CREATE, { json: session() });
    await accounts.connectWithCredentials(env.scope, input({ pdsUrl: "https://pds.example.com/" }));
    expect(pds.requests[0]!.url).toMatch(/^https:\/\/pds\.example\.com\//);
    expect((await rows(env.project.id))[0]!.settings).toEqual({ pdsUrl: "https://pds.example.com" });
  });

  it.each([
    ["wrong password", { status: 401, json: { error: "AuthenticationRequired", message: "no" } }, "appPassword"],
    ["sign-in code", { status: 401, json: { error: "AuthFactorTokenRequired", message: "code" } }, "appPassword"],
    ["suspended", { status: 400, json: { error: "AccountTakedown", message: "x" } }, undefined],
    ["unreachable", { status: 502, json: { error: "BadGateway" } }, "pdsUrl"],
    ["not a PDS", { json: { hello: "world" } }, "pdsUrl"],
    ["not a PDS: HTML 404", { status: 404, json: { error: "XRPCNotSupported" } }, "pdsUrl"],
    ["not a PDS: method not allowed", { status: 400, json: { error: "InvalidRequest" } }, "pdsUrl"],
  ] as const)("%s leaves the database untouched", async (_name, script, field) => {
    const env = await postsEnv();
    pds.route("POST", CREATE, script);
    const out = await accounts.connectWithCredentials(env.scope, input());
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(field ? Object.keys(out.fieldErrors ?? {}) : []).toEqual(field ? [field] : []);
    expect(out.message).not.toContain(PASSWORD);
    expect(await rows(env.project.id)).toHaveLength(0);
  });

  it("reports the retry time on a rate limit", async () => {
    const env = await postsEnv();
    pds.route("POST", CREATE, { status: 429, headers: { "retry-after": "600" }, json: { error: "RateLimitExceeded" } });
    const out = await accounts.connectWithCredentials(env.scope, input());
    expect(out).toMatchObject({ ok: false, message: expect.stringMatching(/Too many/), retryAt: expect.any(Date) });
    expect(await rows(env.project.id)).toHaveLength(0);
  });

  it("connecting the same DID twice keeps one row", async () => {
    const env = await postsEnv();
    pds.route("POST", CREATE, [{ json: session() }, { json: session("did:plc:alice", "alice.new.example") }]);
    await accounts.connectWithCredentials(env.scope, input());
    await accounts.connectWithCredentials(env.scope, input());
    const list = await rows(env.project.id);
    expect(list).toHaveLength(1);
    expect(list[0]!.displayName).toBe("alice.new.example");
  });

  it("reconnects the same DID, reactivating it and clearing the error", async () => {
    const env = await postsEnv();
    pds.route("POST", CREATE, { json: session() });
    const first = await accounts.connectWithCredentials(env.scope, input());
    if (!first.ok) throw new Error("setup");
    await flag(env.project.id, first.account.id, "needs_reauth", "Bluesky refused to renew the session");
    const out = await accounts.connectWithCredentials(env.scope, input({}, first.account.id));
    expect(out).toMatchObject({ ok: true, account: { id: first.account.id, status: "active", lastError: null } });
    expect(await rows(env.project.id)).toHaveLength(1);
  });

  it("refuses a reconnect as a different DID and leaves the row untouched", async () => {
    const env = await postsEnv();
    pds.route("POST", CREATE, [{ json: session() }, { json: session("did:plc:bob", "bob.bsky.social") }]);
    const first = await accounts.connectWithCredentials(env.scope, input());
    if (!first.ok) throw new Error("setup");
    await flag(env.project.id, first.account.id, "needs_reauth", "old");
    const out = await accounts.connectWithCredentials(env.scope, input({ handle: "bob.bsky.social" }, first.account.id));
    expect(out).toMatchObject({ ok: false, message: expect.stringMatching(/different Bluesky account/) });
    const list = await rows(env.project.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ externalAccountId: "did:plc:alice", status: "needs_reauth", lastError: "old" });
  });

  it("refuses an editor with zero PDS requests", async () => {
    const env = await postsEnv();
    pds.route("POST", CREATE, { json: session() });
    await expect(accounts.connectWithCredentials(await env.as(env.editor), input())).rejects.toBeInstanceOf(ForbiddenError);
    expect(pds.requests).toHaveLength(0);
    expect(await rows(env.project.id)).toHaveLength(0);
  });

  it.each([
    ["an empty handle", { handle: "  " }, "handle"],
    ["a missing password", { appPassword: "" }, "appPassword"],
    ["an http PDS", { pdsUrl: "http://pds.example.com" }, "pdsUrl"],
    ["a PDS with a path", { pdsUrl: "https://pds.example.com/xrpc" }, "pdsUrl"],
    ["an over-long handle", { handle: "a".repeat(2049) }, "handle"],
  ])("rejects %s with zero PDS requests", async (_name, fields, field) => {
    const env = await postsEnv();
    pds.route("POST", CREATE, { json: session() });
    const out = await accounts.connectWithCredentials(env.scope, input(fields));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(Object.keys(out.fieldErrors ?? {})).toContain(field);
    expect(pds.requests).toHaveLength(0);
  });

  it("refuses unknown providers, other providers' accounts and removed accounts", async () => {
    const env = await postsEnv();
    pds.route("POST", CREATE, { json: session() });
    await expect(accounts.connectWithCredentials(env.scope, { providerKey: "nope", fields: {} })).rejects.toBeInstanceOf(NotFoundError);
    const mock = await env.account({}, false);
    await expect(accounts.connectWithCredentials(env.scope, input({}, mock.id))).rejects.toBeInstanceOf(ConflictError);
    await expect(accounts.connectWithCredentials(env.scope, input({}, crypto.randomUUID()))).rejects.toBeInstanceOf(NotFoundError);
    expect(pds.requests).toHaveLength(0);
  });

  it("lists Bluesky as credential-connectable", async () => {
    const env = await postsEnv();
    const providers = await accounts.listConnectableProviders(env.scope);
    expect(providers.find((p) => p.key === "bluesky")).toMatchObject({ credentialConnect: true });
  });
});
