import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { postTargets } from "../../../src/server/db/schema/posts";
import { socialAccounts } from "../../../src/server/db/schema/accounts";
import { runTick } from "../../../src/server/scheduler";
import * as accounts from "../../../src/server/services/accounts";
import { closeDb, testDb } from "../../helpers/db";
import { createFakePds, mintJwt, type FakePds } from "../../helpers/fake-pds";
import { postsEnv } from "../../helpers/posts-env";
import { createDueTarget, parkAllDueTargets } from "../../helpers/scheduling";

const CREATE_SESSION = "/xrpc/com.atproto.server.createSession";
const REFRESH_SESSION = "/xrpc/com.atproto.server.refreshSession";
const CREATE_RECORD = "/xrpc/com.atproto.repo.createRecord";
const DID = "did:plc:ewvi7nxzyoun6zhxrhs64oiz";
const CID = "bafyreib2rxk3rybk3aobmv5cjuql3bm2twh4jo5uxgf5kpqcsgzmq2vz2m";
const URI = `at://${DID}/app.bsky.feed.post/3kabcdefghijk`;
const FRESH_ACCESS = mintJwt(new Date(Date.now() + 3_600_000));
const REFRESH = mintJwt(new Date(Date.now() + 60 * 86_400_000));
const NEW_ACCESS = mintJwt(new Date(Date.now() + 7_200_000));
const NEW_REFRESH = mintJwt(new Date(Date.now() + 61 * 86_400_000));
const rotated = (handle = "me.bsky.social") => ({ accessJwt: NEW_ACCESS, refreshJwt: NEW_REFRESH, did: DID, handle });

let pds: FakePds;
beforeEach(async () => {
  await parkAllDueTargets();
  pds = createFakePds();
  vi.stubGlobal("fetch", pds.fetch);
});
afterEach(() => vi.unstubAllGlobals());
afterAll(closeDb);

async function setup(opts: { accessJwt?: string } = {}) {
  const env = await postsEnv();
  pds.route("POST", CREATE_SESSION, {
    json: { accessJwt: opts.accessJwt ?? FRESH_ACCESS, refreshJwt: REFRESH, did: DID, handle: "me.bsky.social" },
  });
  const connect = () =>
    accounts.connectWithCredentials(env.scope, {
      providerKey: "bluesky",
      fields: { handle: "me.bsky.social", appPassword: "abcd-efgh-ijkl-mnop", pdsUrl: "" },
    });
  const out = await connect();
  if (!out.ok) throw new Error("connect failed");
  const accountId = out.account.id;
  const { target } = await createDueTarget(env.project.id, accountId, { baseText: "hello" });
  const tick = async () => runTick({ config: {} });
  const row = async () => (await testDb().select().from(postTargets).where(and(eq(postTargets.projectId, env.project.id), eq(postTargets.id, target.id))))[0]!;
  const account = async () => (await testDb().select().from(socialAccounts).where(and(eq(socialAccounts.projectId, env.project.id), eq(socialAccounts.id, accountId))))[0]!;
  const dueNow = () =>
    testDb().update(postTargets).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(and(eq(postTargets.projectId, env.project.id), eq(postTargets.id, target.id)));
  return { env, accountId, connect, tick, row, account, dueNow };
}

describe("Bluesky sessions through the real scheduler", () => {
  it("refreshes a nearly expired access token before publishing, with one refresh request", async () => {
    pds.route("POST", REFRESH_SESSION, { json: rotated() });
    pds.route("POST", CREATE_RECORD, { json: { uri: URI, cid: CID } });
    const { tick, row, account } = await setup({ accessJwt: mintJwt(new Date(Date.now() + 60_000)) });
    const before = (await account()).credentialsEncrypted;
    expect((await tick()).publishing.counts).toMatchObject({ claimed: 1, done: 1 });
    expect((await row()).status).toBe("published");
    expect(pds.callsTo("POST", REFRESH_SESSION)).toHaveLength(1);
    const publish = pds.callsTo("POST", CREATE_RECORD);
    expect(publish).toHaveLength(1);
    expect(publish[0]!.headers.authorization).toBe(`Bearer ${NEW_ACCESS}`);
    const after = await account();
    expect(after.credentialsEncrypted).not.toBe(before);
    expect(after.status).toBe("active");
  });

  it("reacts to ExpiredToken on create: retryable, refreshes, and the next tick publishes once", async () => {
    pds.route("POST", REFRESH_SESSION, { json: rotated() });
    pds.route("POST", CREATE_RECORD, [{ status: 400, json: { error: "ExpiredToken", message: "Token has expired" } }, { json: { uri: URI, cid: CID } }]);
    const { tick, row, account, dueNow } = await setup();
    expect((await tick()).publishing.counts).toMatchObject({ claimed: 1, retried: 1 });
    expect((await row()).status).not.toBe("published");
    expect(pds.callsTo("POST", REFRESH_SESSION)).toHaveLength(1);
    expect((await account()).status).toBe("active");
    await dueNow();
    expect((await tick()).publishing.counts).toMatchObject({ claimed: 1, done: 1 });
    expect((await row()).status).toBe("published");
    expect(pds.callsTo("POST", CREATE_RECORD)).toHaveLength(2);
    expect(pds.callsTo("POST", CREATE_RECORD)[1]!.headers.authorization).toBe(`Bearer ${NEW_ACCESS}`);
  });

  it("flags needs_reauth with a readable reason when the refresh is refused, then reports account_unavailable", async () => {
    pds.route("POST", REFRESH_SESSION, { status: 400, json: { error: "ExpiredToken", message: "refresh expired" } });
    pds.route("POST", CREATE_RECORD, { status: 401, json: { error: "AuthenticationRequired" } });
    const { tick, row, account, dueNow } = await setup();
    await tick();
    const a = await account();
    expect(a.status).toBe("needs_reauth");
    expect(a.lastError).toContain("Reconnect the account with an app password");
    expect(a.lastError).not.toContain(REFRESH);
    await dueNow();
    await tick();
    const failed = await row();
    expect(failed.status).toBe("failed");
    expect(failed.lastError).toBe("The account is no longer available for publishing.");
    expect(pds.callsTo("POST", CREATE_RECORD)).toHaveLength(1);
  });

  it("keeps the account active when the refresh fails transiently", async () => {
    pds.route("POST", REFRESH_SESSION, { status: 503, json: { error: "Unavailable" } });
    pds.route("POST", CREATE_RECORD, { status: 400, json: { error: "ExpiredToken" } });
    const { tick, row, account } = await setup();
    expect((await tick()).publishing.counts).toMatchObject({ claimed: 1, retried: 1 });
    expect((await account()).status).toBe("active");
    expect((await row()).status).not.toBe("failed");
  });

  it("updates the display name when the handle changed", async () => {
    pds.route("POST", REFRESH_SESSION, { json: rotated("renamed.bsky.social") });
    pds.route("POST", CREATE_RECORD, { json: { uri: URI, cid: CID } });
    const { tick, account } = await setup({ accessJwt: mintJwt(new Date(Date.now() + 60_000)) });
    await tick();
    expect((await account()).displayName).toBe("renamed.bsky.social");
  });

  it("renews an idle account near refresh-JWT expiry in the scheduled section", async () => {
    pds.route("POST", REFRESH_SESSION, { json: rotated() });
    const { tick, account, accountId, env } = await setup();
    const projectId = env.project.id;
    await parkAllDueTargets();
    await testDb().update(socialAccounts).set({ credentialsExpiresAt: new Date(Date.now() + 3_600_000) }).where(and(eq(socialAccounts.projectId, projectId), eq(socialAccounts.id, accountId)));
    const summary = await tick();
    expect(summary.tokenRefresh).toMatchObject({ ok: true });
    expect(pds.callsTo("POST", REFRESH_SESSION).length).toBeGreaterThanOrEqual(1);
    const a = await account();
    expect(a.credentialsExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 30 * 86_400_000);
    expect(a.lastRefreshedAt).not.toBeNull();
  });

  it("restores active when the account is reconnected", async () => {
    const { connect, account, accountId, env } = await setup();
    const projectId = env.project.id;
    await testDb().update(socialAccounts).set({ status: "needs_reauth", lastError: "x" }).where(and(eq(socialAccounts.projectId, projectId), eq(socialAccounts.id, accountId)));
    const out = await connect();
    expect(out.ok).toBe(true);
    const a = await account();
    expect(a.status).toBe("active");
    expect(a.lastError).toBeNull();
  });
});
