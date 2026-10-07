import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { postTargets } from "../../../src/server/db/schema/posts";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { runTick } from "../../../src/server/scheduler";
import { setStorageForTests } from "../../../src/server/storage";
import { encryptCredentials } from "../../../src/server/services/accounts";
import { atTime } from "../../helpers/clock";
import { closeDb, testDb } from "../../helpers/db";
import { createProjectWithMembers } from "../../helpers/factories";
import { createFakeX, rateLimited, type FakeX } from "../../helpers/fake-x";
import { jpeg } from "../../helpers/images";
import { createDueTarget, parkAllDueTargets } from "../../helpers/scheduling";
import { createMemoryStorage } from "../../helpers/storage";

const TWEETS = "/2/tweets";
const ACCESS = "X-ACCESS-TOKEN-e2e-0123456789";
const REFRESH = "X-REFRESH-TOKEN-e2e-0123456789";
const T0 = Date.now() + 60_000;

let fake: FakeX;
let storage: ReturnType<typeof createMemoryStorage>;
beforeEach(async () => {
  storage = createMemoryStorage();
  setStorageForTests(storage);
  await parkAllDueTargets();
  fake = createFakeX().install();
  fake.secrets(ACCESS, REFRESH);
});
afterEach(() => fake.uninstall());
afterAll(async () => {
  setStorageForTests(undefined);
  await closeDb();
});

/** Ticks with the engine clock pinned `seconds` after T0 (no sleeping). */
const tickAt = (seconds: number) => atTime(new Date(T0 + seconds * 1000), async () => (await runTick({ config: {} })).publishing.counts);

async function setup(text: string, images: readonly string[] = []) {
  const ctx = await createProjectWithMembers();
  const projectId = ctx.project.id;
  const repos = forSchedulerProject(projectId);
  const account = await repos.accounts.upsertConnected({
    providerKey: "x",
    displayName: "@dockettest",
    externalAccountId: "2244994945",
    settings: { username: "dockettest", name: "Docket Test" },
    credentialsEncrypted: null,
    credentialsExpiresAt: null,
    connectedByUserId: null,
  });
  const now = Date.now();
  const credentials = { v: 1, accessToken: ACCESS, refreshToken: REFRESH, accessExpiresAt: now + 3_600_000, refreshIssuedAt: now };
  const expires = new Date(now + 180 * 86_400_000);
  await repos.accounts.setCredentials(account.id, encryptCredentials(account.id, credentials), expires);
  const { post, target } = await createDueTarget(projectId, account.id, { baseText: text });
  if (images.length) {
    const repos2 = forSchedulerProject(projectId);
    const ids: string[] = [];
    for (const [i, alt] of images.entries()) {
      const body = await jpeg(300, 200);
      const key = `projects/${projectId}/media/${i}/original`;
      await storage.put(key, body, "image/jpeg");
      const asset = await repos2.media.insert({ storageKey: key, publicUrl: storage.publicUrl(key), mimeType: "image/jpeg", byteSize: body.length, width: 300, height: 200 });
      if (alt) await repos2.media.updateAlt(asset.id, alt);
      ids.push(asset.id);
    }
    await repos2.posts.setMedia(post.id, ids);
  }
  const row = async () =>
    (await testDb().select().from(postTargets).where(and(eq(postTargets.projectId, projectId), eq(postTargets.id, target.id))))[0]!;
  return { row };
}

describe("X text posts through the real scheduler", () => {
  it("publishes a text post in exactly one tick and one request", async () => {
    fake.on("POST", TWEETS, { kind: "ok", status: 201, body: { data: { id: "1445880548472328192", text: "hello x" } } });
    const { row } = await setup("hello x");
    expect(await tickAt(0)).toMatchObject({ claimed: 1, done: 1 });
    expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual([`POST ${TWEETS}`]);
    expect(fake.requests[0]).toMatchObject({ auth: "bearer", fields: { text: "hello x" } });
    expect(await row()).toMatchObject({
      status: "published",
      externalId: "1445880548472328192",
      externalUrl: "https://x.com/dockettest/status/1445880548472328192",
    });
  });

  it("never retries an ambiguous create on later ticks", async () => {
    fake.on("POST", TWEETS, { kind: "problem", status: 503, title: "Service Unavailable" });
    const { row } = await setup("maybe posted");
    expect(await tickAt(0)).toMatchObject({ claimed: 1 });
    const after = await row();
    expect(after.status).not.toBe("published");
    expect(after.externalId).toBeNull();
    for (const s of [30, 600, 7200]) expect(await tickAt(s)).toMatchObject({ claimed: 0 });
    expect(fake.callsTo("POST", TWEETS)).toHaveLength(1);
  });

  it("retries a 401 on a later tick and then publishes", async () => {
    fake.on("POST", TWEETS, [
      { kind: "problem", status: 401, title: "Unauthorized" },
      { kind: "ok", status: 201, body: { data: { id: "77" } } },
    ]);
    const { row } = await setup("after 401");
    expect(await tickAt(0)).toMatchObject({ claimed: 1, retried: 1 });
    const waiting = await row();
    expect(waiting.status).not.toBe("published");
    expect(await tickAt(waiting.nextAttemptAt ? (waiting.nextAttemptAt.getTime() - T0) / 1000 + 1 : 600)).toMatchObject({ claimed: 1, done: 1 });
    expect(fake.callsTo("POST", TWEETS)).toHaveLength(2);
    expect(await row()).toMatchObject({ status: "published", externalId: "77" });
  });

  it("holds a rate-limited post until the reset without a second request", async () => {
    const reset = Math.floor(T0 / 1000) + 900;
    fake.on("POST", TWEETS, [
      { kind: "problem", status: 429, headers: rateLimited({ remaining: 0, reset }) },
      { kind: "ok", status: 201, body: { data: { id: "88" } } },
    ]);
    const { row } = await setup("limited");
    expect(await tickAt(0)).toMatchObject({ claimed: 1, retried: 1 });
    expect((await row()).nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(reset * 1000);
    expect(await tickAt(60)).toMatchObject({ claimed: 0 });
    expect(fake.callsTo("POST", TWEETS)).toHaveLength(1);
    expect(await tickAt(901)).toMatchObject({ claimed: 1, done: 1 });
  });
});

describe("X images through the real scheduler", () => {
  const INIT = "/2/media/upload/initialize";
  const METADATA = "/2/media/metadata";
  const STATUS = "/2/media/upload";
  const trail = () => fake.requests.map((r) => `${r.method} ${r.path}${r.query.command ? `?command=${r.query.command}` : ""}`);

  beforeEach(() => {
    // Variant URLs point at the in-memory storage; everything else goes to the fake X.
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.host === "api.x.com") return inner(input, init);
      const body = await storage.get(decodeURIComponent(url.pathname.slice(1)));
      return body ? new Response(new Uint8Array(body), { status: 200, headers: { "content-type": "image/jpeg" } }) : new Response("gone", { status: 404 });
    });
  });

  const scriptUploads = (finalize: unknown = { data: { id: "5001", expires_after_secs: 86400 } }) => {
    let n = 0;
    fake.on("POST", INIT, () => ({ kind: "ok", body: { data: { id: String(5001 + n++), expires_after_secs: 86400 } } }));
    fake.on("POST", "/2/media/upload/5001/append", { kind: "ok", body: { data: {} } });
    fake.on("POST", "/2/media/upload/5002/append", { kind: "ok", body: { data: {} } });
    fake.on("POST", "/2/media/upload/5001/finalize", { kind: "ok", body: finalize });
    fake.on("POST", "/2/media/upload/5002/finalize", { kind: "ok", body: { data: { id: "5002", expires_after_secs: 86400 } } });
    fake.on("POST", METADATA, { kind: "ok", body: { data: { id: "x" } } });
    fake.on("POST", TWEETS, { kind: "ok", status: 201, body: { data: { id: "1445880548472328192" } } });
  };

  it("publishes two described images, one step per tick, then creates the post with ordered media ids", async () => {
    scriptUploads();
    const { row } = await setup("two pictures", ["first alt", "second alt"]);
    for (let i = 0; i < 4; i++) {
      expect(await tickAt(i)).toMatchObject({ claimed: 1, done: 0 });
      expect(fake.callsTo("POST", TWEETS)).toHaveLength(0);
    }
    expect(await tickAt(4)).toMatchObject({ claimed: 1, done: 1 });
    expect(trail()).toEqual([
      `POST ${INIT}`, "POST /2/media/upload/5001/append", "POST /2/media/upload/5001/finalize", `POST ${METADATA}`,
      `POST ${INIT}`, "POST /2/media/upload/5002/append", "POST /2/media/upload/5002/finalize", `POST ${METADATA}`,
      `POST ${TWEETS}`,
    ]);
    expect(fake.callsTo("POST", METADATA).map((r) => r.fields)).toEqual([
      { id: "5001", metadata: { alt_text: { text: "first alt" } } },
      { id: "5002", metadata: { alt_text: { text: "second alt" } } },
    ]);
    expect(fake.callsTo("POST", TWEETS)[0]!.fields).toMatchObject({ media: { media_ids: ["5001", "5002"] } });
    expect(await row()).toMatchObject({ status: "published", externalId: "1445880548472328192" });
  });

  it("waits for a pending finalize, then checks the status before describing", async () => {
    scriptUploads({ data: { id: "5001", processing_info: { state: "pending", check_after_secs: 30 } } });
    fake.on("GET", `${STATUS}?command=STATUS`, { kind: "ok", body: { data: { id: "5001", processing_info: { state: "succeeded" } } } });
    const { row } = await setup("one picture", ["alt"]);
    expect(await tickAt(0)).toMatchObject({ claimed: 1 });
    expect(await tickAt(5)).toMatchObject({ claimed: 0 });
    expect(fake.callsTo("GET", STATUS)).toHaveLength(0);
    expect(await tickAt(31)).toMatchObject({ claimed: 1 });
    expect(fake.callsTo("GET", STATUS)).toHaveLength(1);
    expect(await tickAt(32)).toMatchObject({ claimed: 1 });
    expect(fake.callsTo("POST", METADATA)).toHaveLength(1);
    expect(await tickAt(33)).toMatchObject({ claimed: 1, done: 1 });
    expect(await row()).toMatchObject({ status: "published" });
    expect(fake.requests.some((r) => r.path === STATUS && r.method === "POST")).toBe(false);
  });

  it("re-uploads an image whose media id expired before create, without sending the post", async () => {
    scriptUploads({ data: { id: "5001", expires_after_secs: 90 } });
    const { row } = await setup("slow image", ["alt"]);
    expect(await tickAt(0)).toMatchObject({ claimed: 1 }); // upload (expires in 90 s)
    expect(await tickAt(1)).toMatchObject({ claimed: 1 }); // describe
    expect(await tickAt(60)).toMatchObject({ claimed: 1, done: 0 }); // create guard: under 60 s left, back to upload
    expect(fake.callsTo("POST", TWEETS)).toHaveLength(0);
    expect(fake.callsTo("POST", INIT)).toHaveLength(1);
    expect(await tickAt(61)).toMatchObject({ claimed: 1 }); // the image is uploaded again
    expect(fake.callsTo("POST", INIT)).toHaveLength(2);
    expect(await row()).not.toMatchObject({ status: "published" });
  });
});
