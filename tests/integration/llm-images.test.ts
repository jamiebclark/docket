import { afterAll, describe, expect, it } from "vitest";
import { createSchedulingRepos, type ProjectScope } from "../../src/server/dal/scope";
import { setStorageForTests } from "../../src/server/storage";
import { closeDb, testDb } from "../helpers/db";
import { createProject } from "../helpers/factories";
import { png } from "../helpers/images";
import { createMemoryStorage } from "../helpers/storage";
import { imagesForModel, isPubliclyFetchable, LLM_REQUEST_IMAGE_BUDGET_BASE64 } from "../../src/server/llm/images";

afterAll(async () => {
  setStorageForTests(undefined);
  await closeDb();
});

async function setup(publicBase = "https://media.example.test") {
  const storage = createMemoryStorage(publicBase);
  setStorageForTests(storage);
  const project = await createProject();
  const repos = createSchedulingRepos(testDb(), project.id);
  const scope = { ...repos, projectId: project.id, project: { id: project.id } } as unknown as ProjectScope;
  async function asset(width: number, height: number, name = "photo.png") {
    const body = await png(width, height);
    const key = `projects/${project.id}/media/${Math.random().toString(36).slice(2)}/original.png`;
    await storage.put(key, body, "image/png");
    return repos.media.insert({
      storageKey: key,
      publicUrl: storage.publicUrl(key),
      mimeType: "image/png",
      byteSize: body.length,
      width,
      height,
      originalFilename: name,
    });
  }
  return { storage, repos, scope, asset };
}

describe("isPubliclyFetchable", () => {
  it.each([
    ["https://media.example.com/a.png", true],
    ["http://media.example.com/a.png", false],
    ["https://localhost/a.png", false],
    ["https://x.localhost/a.png", false],
    ["https://nas.local/a.png", false],
    ["https://10.0.0.1/a.png", false],
    ["https://[::1]/a.png", false],
  ])("%s → %s", (url, expected) => expect(isPubliclyFetchable(url)).toBe(expected));
});

describe("imagesForModel", () => {
  it("returns nothing for no assets", async () => {
    const t = await setup();
    expect(await imagesForModel(t.scope, [])).toEqual({ ok: true, images: [], record: [] });
  });

  it("uses a url for a public https host", async () => {
    const t = await setup("https://media.example.com");
    const a = await t.asset(800, 600);
    const r = await imagesForModel(t.scope, [a]);
    expect(r.ok && r.images[0]).toMatchObject({ kind: "url", mediaType: "image/png" });
    expect(r.ok && r.record).toEqual([{ mediaAssetId: a.id, mode: "url" }]);
  });

  it("sends bytes for localhost storage", async () => {
    const t = await setup("https://localhost:9000/docket");
    const a = await t.asset(800, 600);
    const r = await imagesForModel(t.scope, [a]);
    expect(r.ok && r.images[0]).toMatchObject({ kind: "bytes" });
    expect(r.ok && r.record[0]?.mode).toBe("bytes");
  });

  it("builds one cached variant for an oversized image and reuses it", async () => {
    const t = await setup("https://localhost:9000/docket");
    const a = await t.asset(3000, 2000);
    const first = await imagesForModel(t.scope, [a]);
    expect(first.ok && first.images[0]).toMatchObject({ kind: "bytes", mediaType: "image/png" });
    const variants = await t.repos.media.listVariants(a.id);
    expect(variants).toHaveLength(1);
    expect(variants[0]).toMatchObject({ width: 2000 });
    const puts = t.storage.objects.size;
    await imagesForModel(t.scope, [a]);
    expect(await t.repos.media.listVariants(a.id)).toHaveLength(1);
    expect(t.storage.objects.size).toBe(puts);
  });

  it("refuses an over-budget set, naming nothing sensitive", async () => {
    const t = await setup("https://localhost:9000/docket");
    const a = await t.asset(100, 100);
    const big = Buffer.alloc(Math.ceil((LLM_REQUEST_IMAGE_BUDGET_BASE64 / 4) * 3) + 10);
    t.storage.objects.set(a.storageKey, { body: big, contentType: "image/png" });
    const r = await imagesForModel(t.scope, [a]);
    expect(r).toEqual({ ok: false, message: "These images are too large to send to the model together." });
  });

  it("names the image when it cannot be read, with no key or url", async () => {
    const t = await setup("https://localhost:9000/docket");
    const a = await t.asset(100, 100, "lost.png");
    t.storage.objects.delete(a.storageKey);
    const r = await imagesForModel(t.scope, [a]);
    expect(r).toEqual({ ok: false, message: "Image 1 (lost.png) could not be prepared for the model." });
  });

  it("reports missing storage", async () => {
    const t = await setup();
    const a = await t.asset(100, 100);
    setStorageForTests(null);
    expect(await imagesForModel(t.scope, [a])).toEqual({ ok: false, message: "Media storage is not set up." });
  });
});
