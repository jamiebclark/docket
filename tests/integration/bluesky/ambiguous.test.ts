import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { postTargets } from "../../../src/server/db/schema/posts";
import { runTick } from "../../../src/server/scheduler";
import * as accounts from "../../../src/server/services/accounts";
import { closeDb, testDb } from "../../helpers/db";
import { createFakePds, mintJwt, type FakePds } from "../../helpers/fake-pds";
import { postsEnv } from "../../helpers/posts-env";
import { createDueTarget, parkAllDueTargets } from "../../helpers/scheduling";

const CREATE_SESSION = "/xrpc/com.atproto.server.createSession";
const CREATE_RECORD = "/xrpc/com.atproto.repo.createRecord";
const DID = "did:plc:ewvi7nxzyoun6zhxrhs64oiz";
const CID = "bafyreib2rxk3rybk3aobmv5cjuql3bm2twh4jo5uxgf5kpqcsgzmq2vz2m";
const ACCESS = mintJwt(new Date("2030-01-01T01:00:00Z"));
const REFRESH = mintJwt(new Date("2030-03-01T00:00:00Z"));

let pds: FakePds;
beforeEach(async () => {
  await parkAllDueTargets();
  pds = createFakePds();
  vi.stubGlobal("fetch", pds.fetch);
});
afterEach(() => vi.unstubAllGlobals());
afterAll(closeDb);

async function setup(text: string) {
  const env = await postsEnv();
  pds.route("POST", CREATE_SESSION, { json: { accessJwt: ACCESS, refreshJwt: REFRESH, did: DID, handle: "me.bsky.social" } });
  const out = await accounts.connectWithCredentials(env.scope, {
    providerKey: "bluesky",
    fields: { handle: "me.bsky.social", appPassword: "abcd-efgh-ijkl-mnop", pdsUrl: "" },
  });
  if (!out.ok) throw new Error("connect failed");
  const { target } = await createDueTarget(env.project.id, out.account.id, { baseText: text });
  const tick = async () => (await runTick({ config: {} })).publishing.counts;
  const row = async () => (await testDb().select().from(postTargets).where(and(eq(postTargets.projectId, env.project.id), eq(postTargets.id, target.id))))[0]!;
  return { env, targetId: target.id, tick, row };
}

describe("Bluesky ambiguous and rate-limited outcomes through the real scheduler", () => {
  it.each([
    ["a 5xx", { status: 500, json: { error: "InternalServerError" } }],
    ["a reset mid-body", { mode: "reset-mid-body" }],
    ["an unparseable 2xx", { text: "<html>ok</html>" }],
    ["a 2xx without a uri", { json: { cid: CID } }],
    ["a 2xx with a malformed at:// uri", { json: { uri: "at://nonsense", cid: CID } }],
  ] as const)("ends ambiguous after %s and is never retried", async (_name, script) => {
    pds.route("POST", CREATE_RECORD, script as Parameters<FakePds["route"]>[2]);
    const { tick, row } = await setup("just words");
    expect(await tick()).toMatchObject({ claimed: 1, ambiguous: 1 });
    expect((await row()).status).toBe("ambiguous");
    expect(await tick()).toMatchObject({ claimed: 0 });
    expect(await tick()).toMatchObject({ claimed: 0 });
    expect(pds.callsTo("POST", CREATE_RECORD)).toHaveLength(1);
    expect((await row()).status).toBe("ambiguous");
  });

  it("honours Retry-After on a 429 by scheduling the next attempt later", async () => {
    pds.route("POST", CREATE_RECORD, { status: 429, headers: { "retry-after": "120" }, json: { error: "RateLimitExceeded" } });
    const { tick, row } = await setup("just words");
    const before = Date.now();
    expect(await tick()).toMatchObject({ claimed: 1, retried: 1 });
    const r = await row();
    expect(r.status).not.toBe("ambiguous");
    expect(r.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(before + 120_000 - 1000);
    expect(await tick()).toMatchObject({ claimed: 0 });
    expect(pds.callsTo("POST", CREATE_RECORD)).toHaveLength(1);
  });

  it("fails a 400 with the platform reason", async () => {
    pds.route("POST", CREATE_RECORD, { status: 400, json: { error: "InvalidRecord", message: "bad record" } });
    const { tick, row } = await setup("just words");
    expect(await tick()).toMatchObject({ claimed: 1, failed: 1 });
    const r = await row();
    expect(r.status).toBe("failed");
    expect(JSON.stringify(r)).toContain("InvalidRecord");
    expect(JSON.stringify(r)).not.toContain(ACCESS);
  });

  it("retries when the connection is refused before anything is sent", async () => {
    pds.route("POST", CREATE_RECORD, { mode: "pre-send-failure", code: "ECONNREFUSED" });
    const { tick, row } = await setup("just words");
    expect(await tick()).toMatchObject({ claimed: 1, retried: 1, ambiguous: 0 });
    expect((await row()).status).not.toBe("ambiguous");
  });
});
