import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setUrlFetchOverridesForTests } from "../../../../src/server/services/media-from-url";
import { setStorageForTests } from "../../../../src/server/storage";
import { api, createKey } from "../../../helpers/api";
import { closeDb } from "../../../helpers/db";
import { htmlAsJpg, jpeg, oversizePixels } from "../../../helpers/images";
import { startImageServer, type ImageServer } from "../../../helpers/image-server";
import { postsEnv } from "../../../helpers/posts-env";
import { createMemoryStorage } from "../../../helpers/storage";
import { createMediaAsset } from "../../../helpers/scheduling";

let images: ImageServer;
beforeAll(async () => {
  images = await startImageServer();
});
afterAll(async () => {
  await images.close();
  await closeDb();
});
afterEach(() => {
  setStorageForTests(undefined);
  setUrlFetchOverridesForTests({});
});

async function setup() {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  setUrlFetchOverridesForTests({ addressPolicy: "allow-loopback" });
  const env = await postsEnv();
  const key = await createKey(env.scope, ["read", "write_posts"], { rateLimitPerMinute: 1000 });
  return { env, storage, key: key.secret };
}

async function form(bytes: Buffer, extra: Record<string, string | string[]> = {}, name = "pic.jpg") {
  const f = new FormData();
  f.set("file", new File([new Uint8Array(bytes)], name, { type: "image/jpeg" }));
  for (const [k, v] of Object.entries(extra)) for (const x of Array.isArray(v) ? v : [v]) f.append(k, x);
  return f;
}

describe("POST /media", () => {
  it("stores an upload with alt text and tags", async () => {
    const { key, storage } = await setup();
    const r = await api("POST", "/media", { key, body: await form(await jpeg(300, 200), { altText: "A cat", tags: "pets, cats" }) });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ width: 300, height: 200, altText: "A cat", tags: ["pets", "cats"], used: false, mimeType: "image/jpeg" });
    expect(storage.objects.size).toBe(2);
    const got = await api("GET", `/media/${r.json.id}`, { key });
    expect(got.status).toBe(200);
    expect(got.json.id).toBe(r.json.id);
  });

  it("answers 415 for non-image bytes, 413 for too many pixels, 400 without a file, and 503 without storage", async () => {
    const { key } = await setup();
    expect((await api("POST", "/media", { key, body: await form(htmlAsJpg()) })).status).toBe(415);
    const big = await api("POST", "/media", { key, body: await form(await oversizePixels(60_000_000)) });
    expect(big.status).toBe(413);
    expect(big.json.error.code).toBe("payload_too_large");
    expect((await api("POST", "/media", { key, body: new FormData() })).json.error.code).toBe("validation_failed");
    expect((await api("POST", "/media", { key, body: { url: "x" } })).status).toBe(415);
    setStorageForTests(null);
    const none = await api("POST", "/media", { key, body: await form(await jpeg()) });
    expect(none.status).toBe(503);
    expect(none.json.error.code).toBe("storage_not_configured");
  });

  it("replays an idempotent upload without storing it twice", async () => {
    const { key, storage } = await setup();
    const bytes = await jpeg(120, 90);
    const a = await api("POST", "/media", { key, idem: "up-1", body: await form(bytes) });
    const b = await api("POST", "/media", { key, idem: "up-1", body: await form(bytes) });
    expect(a.status).toBe(201);
    expect(b.json.id).toBe(a.json.id);
    expect(b.headers.get("idempotent-replayed")).toBe("true");
    expect(storage.objects.size).toBe(2);
  });
});

describe("POST /media/from-url", () => {
  it("imports an image and follows up to 3 redirects", async () => {
    const { key } = await setup();
    const direct = await api("POST", "/media/from-url", { key, body: { url: images.ok, altText: "From the web", tags: ["web"] } });
    expect(direct.status).toBe(201);
    expect(direct.json).toMatchObject({ altText: "From the web", tags: ["web"], width: 200, height: 100 });
    expect((await api("POST", "/media/from-url", { key, body: { url: images.redirectChain(3) } })).status).toBe(201);
    const four = await api("POST", "/media/from-url", { key, body: { url: images.redirectChain(4) } });
    expect(four.status).toBe(400);
    expect(four.json.error.code).toBe("url_too_many_redirects");
  });

  it("refuses private destinations, schemes and credentials", async () => {
    const { key, storage } = await setup();
    const code = async (url: string) => (await api("POST", "/media/from-url", { key, body: { url } })).json.error.code;
    expect(await code(images.redirectTo("http://169.254.169.254/latest/meta-data"))).toBe("url_not_allowed");
    expect(await code("file:///etc/passwd")).toBe("url_not_allowed");
    expect(await code("http://user:pass@example.com/a.jpg")).toBe("url_not_allowed");
    setUrlFetchOverridesForTests({});
    expect(await code(images.ok)).toBe("url_not_allowed");
    expect(await code("http://169.254.169.254/x")).toBe("url_not_allowed");
    expect(await code("http://[::1]/x")).toBe("url_not_allowed");
    expect(storage.objects.size).toBe(0);
  });

  it("maps a bad status, an oversize body, a non-image and a timeout", async () => {
    const { key } = await setup();
    const call = (url: string) => api("POST", "/media/from-url", { key, body: { url } });
    expect((await call(images.status(404))).json.error.code).toBe("url_fetch_failed");
    const html = await call(images.status(200));
    expect(html.status).toBe(415);
    expect((await call(images.oversize(30 * 1024 * 1024))).status).toBe(413);
    setUrlFetchOverridesForTests({ addressPolicy: "allow-loopback", timeoutMs: 300 });
    const slow = await call(images.slow(3000));
    expect(slow.status).toBe(400);
    expect(slow.json.error.code).toBe("url_timeout");
  });

  it("answers 503 without storage", async () => {
    const { key } = await setup();
    setStorageForTests(null);
    const r = await api("POST", "/media/from-url", { key, body: { url: images.ok } });
    expect(r.json.error.code).toBe("storage_not_configured");
  });
});

describe("GET /media", () => {
  it("pages the library and filters unused=true", async () => {
    const { env, key } = await setup();
    const used = await createMediaAsset(env.project.id, { altText: "used" });
    const fresh = await createMediaAsset(env.project.id, { altText: "fresh" });
    const account = await env.account({}, false);
    const made = await api("POST", "/posts", { key, body: { text: "hi", accountIds: [account.id], mediaIds: [used.id] } });
    expect(made.status).toBe(201);
    const all = await api("GET", "/media?limit=1", { key });
    expect(all.json.data).toHaveLength(1);
    expect(all.json.nextCursor).toEqual(expect.any(String));
    const next = await api("GET", `/media?limit=100&cursor=${all.json.nextCursor}`, { key });
    expect(next.json.data.length).toBeGreaterThanOrEqual(1);
    const unused = await api("GET", "/media?unused=true&limit=100", { key });
    const ids = unused.json.data.map((m: { id: string }) => m.id);
    expect(ids).toContain(fresh.id);
    expect(ids).not.toContain(used.id);
    expect((await api("GET", "/media?limit=0", { key })).status).toBe(400);
    expect((await api("GET", "/media/not-a-uuid", { key })).status).toBe(404);
  });
});
