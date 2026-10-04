import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { postTargets } from "../../../src/server/db/schema/posts";
import { createSchedulingRepos } from "../../../src/server/dal/scope";
import { runTick } from "../../../src/server/scheduler";
import * as accounts from "../../../src/server/services/accounts";
import * as posts from "../../../src/server/services/posts";
import { setStorageForTests } from "../../../src/server/storage";
import { closeDb, testDb } from "../../helpers/db";
import { createFakePds, mintJwt, type FakePds } from "../../helpers/fake-pds";
import { jpeg, noisePng } from "../../helpers/images";
import { postsEnv } from "../../helpers/posts-env";
import { createDueTarget, parkAllDueTargets } from "../../helpers/scheduling";
import { createMemoryStorage, type MemoryStorage } from "../../helpers/storage";

const CREATE_SESSION = "/xrpc/com.atproto.server.createSession";
const UPLOAD = "/xrpc/com.atproto.repo.uploadBlob";
const CREATE_RECORD = "/xrpc/com.atproto.repo.createRecord";
const DID = "did:plc:ewvi7nxzyoun6zhxrhs64oiz";
const CID = "bafyreib2rxk3rybk3aobmv5cjuql3bm2twh4jo5uxgf5kpqcsgzmq2vz2m";
const ACCESS = mintJwt(new Date("2030-01-01T01:00:00Z"));
const REFRESH = mintJwt(new Date("2030-03-01T00:00:00Z"));
const MAX = 2_000_000;

let pds: FakePds;
let storage: MemoryStorage;
beforeEach(async () => {
  await parkAllDueTargets();
  pds = createFakePds();
  storage = createMemoryStorage();
  setStorageForTests(storage);
  // Variant URLs point at the in-memory storage; everything else goes to the fake PDS.
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin === "https://media.example.test") {
      const body = await storage.get(decodeURIComponent(url.pathname.slice(1)));
      return body ? new Response(new Uint8Array(body), { status: 200, headers: { "content-type": "image/jpeg" } }) : new Response("gone", { status: 404 });
    }
    return pds.fetch(input, init);
  });
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  setStorageForTests(undefined);
  await closeDb();
});

async function setup(sources: readonly { body: Buffer; mimeType: string; alt: string; width: number; height: number }[]) {
  const env = await postsEnv();
  pds.route("POST", CREATE_SESSION, { json: { accessJwt: ACCESS, refreshJwt: REFRESH, did: DID, handle: "me.bsky.social" } });
  const out = await accounts.connectWithCredentials(env.scope, {
    providerKey: "bluesky",
    fields: { handle: "me.bsky.social", appPassword: "abcd-efgh-ijkl-mnop", pdsUrl: "" },
  });
  if (!out.ok) throw new Error("connect failed");
  const { post, target } = await createDueTarget(env.project.id, out.account.id, { baseText: "pictures" });
  const repos = createSchedulingRepos(testDb(), env.project.id);
  const ids: string[] = [];
  for (const [i, s] of sources.entries()) {
    const key = `projects/${env.project.id}/media/${i}/original`;
    await storage.put(key, s.body, s.mimeType);
    const asset = await repos.media.insert({
      storageKey: key,
      publicUrl: storage.publicUrl(key),
      mimeType: s.mimeType,
      byteSize: s.body.length,
      width: s.width,
      height: s.height,
    });
    await repos.media.updateAlt(asset.id, s.alt);
    ids.push(asset.id);
  }
  await repos.posts.setMedia(post.id, ids);
  const tick = async () => (await runTick({ config: {} })).publishing.counts;
  const row = async () => (await testDb().select().from(postTargets).where(and(eq(postTargets.projectId, env.project.id), eq(postTargets.id, target.id))))[0]!;
  return { env, targetId: target.id, tick, row };
}

const small = async (alt: string) => ({ body: await jpeg(300, 200), mimeType: "image/jpeg", alt, width: 300, height: 200 });
let n = 0;
const routeUpload = () => pds.route("POST", UPLOAD, () => ({ json: { blob: { $type: "blob", ref: { $link: CID }, mimeType: "image/jpeg", size: 100 + n++ } } }));
const routeCreate = () => pds.route("POST", CREATE_RECORD, { json: { uri: `at://${DID}/app.bsky.feed.post/3kimg`, cid: CID } });

describe("Bluesky image publishing through the real scheduler", () => {
  it("publishes three images (one oversized source) in four ticks from the Bluesky variant", async () => {
    routeUpload();
    routeCreate();
    const big = { body: await noisePng(1600, 1200), mimeType: "image/png", alt: "big one", width: 1600, height: 1200 };
    expect(big.body.length).toBeGreaterThan(MAX);
    const { tick, row } = await setup([await small("first"), big, await small("third")]);

    for (let i = 0; i < 3; i++) {
      expect(await tick()).toMatchObject({ claimed: 1, done: 0 });
      expect(pds.callsTo("POST", CREATE_RECORD)).toHaveLength(0);
    }
    expect(await tick()).toMatchObject({ claimed: 1, done: 1 });
    expect(await row()).toMatchObject({ status: "published", externalId: `at://${DID}/app.bsky.feed.post/3kimg` });

    const uploads = pds.callsTo("POST", UPLOAD);
    expect(uploads).toHaveLength(3);
    for (const u of uploads) {
      expect(u.headers["content-type"]).toBe("image/jpeg");
      expect((u.body as Uint8Array).byteLength).toBeLessThanOrEqual(MAX);
    }
    const { record } = pds.callsTo("POST", CREATE_RECORD)[0]!.body as {
      record: { embed: { $type: string; images: { alt: string; image: { size: number }; aspectRatio?: { width: number; height: number } }[] } };
    };
    expect(record.embed.$type).toBe("app.bsky.embed.images");
    expect(record.embed.images.map((i) => i.alt)).toEqual(["first", "big one", "third"]);
    expect(record.embed.images.map((i) => i.image.size)).toEqual([100, 101, 102].map((s) => s + (n - 3)));
    expect(record.embed.images.every((i) => i.aspectRatio && i.aspectRatio.width > 0 && i.aspectRatio.height > 0)).toBe(true);
  });

  it("re-uploads only the image whose upload timed out, and is never ambiguous", async () => {
    routeCreate();
    pds.route("POST", UPLOAD, [{ json: { blob: { $type: "blob", ref: { $link: CID }, mimeType: "image/jpeg", size: 1 } } }, { status: 503, json: { error: "Unavailable" } }, { json: { blob: { $type: "blob", ref: { $link: CID }, mimeType: "image/jpeg", size: 2 } } }]);
    const { tick, row } = await setup([await small("a"), await small("b")]);
    expect(await tick()).toMatchObject({ claimed: 1, retried: 0 });
    const second = await tick();
    expect(second).toMatchObject({ claimed: 1, retried: 1, ambiguous: 0 });
    expect((await row()).status).not.toBe("ambiguous");
    expect(pds.callsTo("POST", UPLOAD)).toHaveLength(2);
    expect(pds.callsTo("POST", CREATE_RECORD)).toHaveLength(0);
  });

  it("fails on an upload 4xx without ever calling createRecord", async () => {
    routeCreate();
    pds.route("POST", UPLOAD, { status: 400, json: { error: "InvalidMimeType", message: "no" } });
    const { tick, row, env, targetId } = await setup([await small("a")]);
    expect(await tick()).toMatchObject({ claimed: 1, failed: 1 });
    expect((await row()).status).toBe("failed");
    expect(pds.callsTo("POST", CREATE_RECORD)).toHaveLength(0);
    const attempts = await posts.listAttempts(env.scope, targetId);
    expect(JSON.stringify(attempts)).not.toContain(ACCESS);
  });

  it("tells the user to use Retry when the post is rejected over an unknown image reference", async () => {
    routeUpload();
    pds.route("POST", CREATE_RECORD, { status: 400, json: { error: "InvalidRecord", message: "Referenced image was not found" } });
    const { tick, row } = await setup([await small("a")]);
    await tick();
    expect(await tick()).toMatchObject({ claimed: 1, failed: 1 });
    expect(await row()).toMatchObject({ status: "failed", lastError: expect.stringContaining("use Retry") });
  });
});
