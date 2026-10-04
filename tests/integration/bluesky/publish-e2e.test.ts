import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { postTargets } from "../../../src/server/db/schema/posts";
import { runTick } from "../../../src/server/scheduler";
import * as accounts from "../../../src/server/services/accounts";
import * as posts from "../../../src/server/services/posts";
import { closeDb, testDb } from "../../helpers/db";
import { createFakePds, mintJwt, type FakePds } from "../../helpers/fake-pds";
import { postsEnv } from "../../helpers/posts-env";
import { createDueTarget, parkAllDueTargets } from "../../helpers/scheduling";

const CREATE_SESSION = "/xrpc/com.atproto.server.createSession";
const RESOLVE = "/xrpc/com.atproto.identity.resolveHandle";
const CREATE_RECORD = "/xrpc/com.atproto.repo.createRecord";
const DID = "did:plc:ewvi7nxzyoun6zhxrhs64oiz";
const CID = "bafyreib2rxk3rybk3aobmv5cjuql3bm2twh4jo5uxgf5kpqcsgzmq2vz2m";
const ALICE_DID = "did:plc:z72i7hdynmk6r22z27h6tvur";
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

describe("Bluesky text publishing through the real scheduler", () => {
  it("publishes text only in one tick and records the id and URL", async () => {
    pds.route("POST", CREATE_RECORD, { json: { uri: `at://${DID}/app.bsky.feed.post/3kabc`, cid: CID } });
    const { tick, row } = await setup("just words");
    expect(await tick()).toMatchObject({ claimed: 1, done: 1 });
    expect(await row()).toMatchObject({
      status: "published",
      externalId: `at://${DID}/app.bsky.feed.post/3kabc`,
      externalUrl: "https://bsky.app/profile/me.bsky.social/post/3kabc",
    });
    expect(pds.callsTo("GET", RESOLVE)).toHaveLength(0);
  });

  it("publishes multibyte text with a link, resolved mention and hashtag in two ticks", async () => {
    pds.route("GET", RESOLVE, { json: { did: ALICE_DID } });
    pds.route("POST", CREATE_RECORD, { json: { uri: `at://${DID}/app.bsky.feed.post/3kdef`, cid: CID } });
    const text = "日本語 café 👨‍👩‍👧 https://example.com/x @alice.bsky.social #docket";
    const { tick, row } = await setup(text);
    expect(await tick()).toMatchObject({ claimed: 1, done: 0 });
    expect(pds.callsTo("POST", CREATE_RECORD)).toHaveLength(0);
    expect((await row()).status).not.toBe("published");
    expect(await tick()).toMatchObject({ claimed: 1, done: 1 });

    const { record } = pds.callsTo("POST", CREATE_RECORD)[0]!.body as {
      record: { text: string; facets: { index: { byteStart: number; byteEnd: number }; features: { $type: string; did?: string }[] }[] };
    };
    expect(record.text).toBe(text);
    const tokens = record.facets.map((f) => Buffer.from(text).subarray(f.index.byteStart, f.index.byteEnd).toString());
    expect(tokens).toEqual(["https://example.com/x", "@alice.bsky.social", "#docket"]);
    expect(record.facets[1]!.features[0]).toMatchObject({ did: ALICE_DID });
  });

  it("publishes an unresolved mention with no mention facet", async () => {
    pds.route("GET", RESOLVE, { status: 400, json: { error: "InvalidRequest", message: "Unable to resolve handle" } });
    pds.route("POST", CREATE_RECORD, { json: { uri: `at://${DID}/app.bsky.feed.post/3kghi`, cid: CID } });
    const text = "hello @ghost.bsky.social #tag";
    const { tick } = await setup(text);
    await tick();
    expect(await tick()).toMatchObject({ done: 1 });
    const { record } = pds.callsTo("POST", CREATE_RECORD)[0]!.body as { record: { text: string; facets: { features: { $type: string }[] }[] } };
    expect(record.text).toBe(text);
    expect(record.facets.flatMap((f) => f.features.map((x) => x.$type))).toEqual(["app.bsky.richtext.facet#tag"]);
  });

  it("retries a failed mention lookup and never goes ambiguous", async () => {
    pds.route("GET", RESOLVE, { status: 503, json: { error: "Unavailable" } });
    const { tick, row, env, targetId } = await setup("hi @ghost.bsky.social");
    expect(await tick()).toMatchObject({ claimed: 1, retried: 1, ambiguous: 0 });
    expect((await row()).status).not.toBe("ambiguous");
    expect(pds.callsTo("POST", CREATE_RECORD)).toHaveLength(0);
    const attempts = await posts.listAttempts(env.scope, targetId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ outcome: "retryable_error" });
    expect(JSON.stringify(attempts)).not.toContain(ACCESS);
  });
});
