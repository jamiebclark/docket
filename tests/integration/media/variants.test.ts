import sharp from "sharp";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createSchedulingRepos } from "../../../src/server/dal/scope";
import { adaptedMediaFor, prepareVariants, resolvePublishMedia } from "../../../src/server/services/media-variants";
import { setStorageForTests } from "../../../src/server/storage";
import { closeDb, testDb } from "../../helpers/db";
import { createProject } from "../../helpers/factories";
import { png } from "../../helpers/images";
import { blueskyLikeProvider, instagramLikeProvider, registerTestProvider } from "../../helpers/provider-fixtures";
import { createDraftPost, createMockAccount } from "../../helpers/scheduling";
import { createMemoryStorage } from "../../helpers/storage";

const insta = registerTestProvider(instagramLikeProvider);
registerTestProvider(blueskyLikeProvider);

afterAll(async () => {
  setStorageForTests(undefined);
  await closeDb();
});
afterEach(() => {
  insta.capabilities.media.maxBytesPerFile = 8_000_000;
});

async function setup() {
  const storage = createMemoryStorage();
  const puts: string[] = [];
  const put = storage.put.bind(storage);
  storage.put = async (k, b, t) => (puts.push(k), put(k, b, t));
  setStorageForTests(storage);
  const project = await createProject();
  const repos = createSchedulingRepos(testDb(), project.id);
  const scope = { ...repos, projectId: project.id, project: { id: project.id } };
  const account = await createMockAccount(project.id, {}, { providerKey: "instagram-like" });
  async function asset(width: number, height: number, store = true) {
    const body = await png(width, height);
    const key = `projects/${project.id}/media/${Math.random().toString(36).slice(2)}/original.png`;
    if (store) await storage.put(key, body, "image/png");
    return repos.media.insert({
      storageKey: key,
      publicUrl: storage.publicUrl(key),
      mimeType: "image/png",
      byteSize: body.length,
      width,
      height,
      altText: "alt",
    });
  }
  async function post(mediaIds: string[], accounts = [account.id]) {
    return createDraftPost(project.id, { accountIds: accounts, mediaIds });
  }
  return { storage, puts, project, repos, scope, account, asset, post };
}

describe("variant service", () => {
  it("creates a variant once and reuses it", async () => {
    const t = await setup();
    const a = await t.asset(2000, 1600);
    const { post } = await t.post([a.id]);
    const first = await prepareVariants(t.scope, post.id);
    expect(first.failures).toEqual([]);
    const putsAfterFirst = t.puts.length;
    expect(putsAfterFirst).toBe(2); // the original (setup) and one variant
    await prepareVariants(t.scope, post.id);
    expect(t.puts.length).toBe(putsAfterFirst);
    const variants = await t.repos.media.listVariants(a.id);
    expect(variants).toHaveLength(1);
    expect(variants[0]).toMatchObject({ mimeType: "image/jpeg", width: 1440 });
    expect(variants[0]!.storageKey.startsWith(`projects/${t.project.id}/`)).toBe(true);
    expect((await sharp(t.storage.objects.get(variants[0]!.storageKey)!.body).metadata()).format).toBe("jpeg");
  });

  it("makes a new variant when a constraint changes", async () => {
    const t = await setup();
    const a = await t.asset(1000, 1000);
    const { post } = await t.post([a.id]);
    await prepareVariants(t.scope, post.id);
    insta.capabilities.media.maxBytesPerFile = 7_000_000;
    await prepareVariants(t.scope, post.id);
    expect(await t.repos.media.listVariants(a.id)).toHaveLength(2);
  });

  it("isolates a per-image failure", async () => {
    const t = await setup();
    const good = await t.asset(1000, 1000);
    const bad = await t.asset(1000, 1000, false);
    const { post } = await t.post([good.id, bad.id]);
    const { failures } = await prepareVariants(t.scope, post.id);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ assetId: bad.id, providerKey: "instagram-like" });
    expect(failures[0]!.message).not.toContain("projects/");
    expect(await t.repos.media.listVariants(good.id)).toHaveLength(1);
  });

  it("reports a failure for every pair when storage is not set up", async () => {
    const t = await setup();
    const a = await t.asset(1000, 1000);
    const { post } = await t.post([a.id]);
    setStorageForTests(null);
    const { failures } = await prepareVariants(t.scope, post.id);
    expect(failures[0]!.message).toBe("Media storage is not set up.");
  });

  it("adaptedMediaFor reports variant_failed until a variant exists, then uses it", async () => {
    const t = await setup();
    const a = await t.asset(1000, 1000);
    const { post } = await t.post([a.id]);
    const before = await adaptedMediaFor(t.repos, insta.capabilities, "Instagram", [a]);
    expect(before.issues.map((i) => i.code)).toEqual(["variant_failed"]);
    await prepareVariants(t.scope, post.id);
    const after = await adaptedMediaFor(t.repos, insta.capabilities, "Instagram", [a]);
    expect(after.issues.map((i) => [i.severity, i.code])).toEqual([["info", "media_will_convert"]]);
    expect(after.media[0]).toMatchObject({ mimeType: "image/jpeg", altText: "alt" });
    expect(after.media[0]!.url).not.toBe(a.publicUrl);
  });

  it("refuses an out-of-range aspect without generating anything", async () => {
    const t = await setup();
    const wide = await t.asset(2000, 800);
    const { post } = await t.post([wide.id]);
    expect((await prepareVariants(t.scope, post.id)).failures).toEqual([]);
    expect(await t.repos.media.listVariants(wide.id)).toHaveLength(0);
    const r = await adaptedMediaFor(t.repos, insta.capabilities, "Instagram", [wide]);
    expect(r.issues.map((i) => i.code)).toEqual(["aspect_ratio_out_of_range"]);
  });

  it("resolvePublishMedia regenerates a vanished variant object", async () => {
    const t = await setup();
    const a = await t.asset(1000, 1000);
    const { post, targets } = await t.post([a.id]);
    await prepareVariants(t.scope, post.id);
    const [v] = await t.repos.media.listVariants(a.id);
    await t.storage.delete(v!.storageKey);
    const r = await resolvePublishMedia(t.scope, targets[0]!.id, insta);
    expect(r.ok).toBe(true);
    expect(await t.storage.exists(v!.storageKey)).toBe(true);
    expect(await t.repos.media.listVariants(a.id)).toHaveLength(1);
  });

  it("resolvePublishMedia fails clearly for a deleted or missing original, with no keys in the text", async () => {
    const t = await setup();
    const a = await t.asset(1000, 1000);
    const b = await t.asset(1000, 1000);
    const { targets } = await t.post([a.id, b.id]);
    await t.repos.media.softDelete(b.id, new Date());
    expect(await resolvePublishMedia(t.scope, targets[0]!.id, insta)).toEqual({ ok: false, error: "Image 2 is no longer available." });
    const c = await t.asset(1000, 1000, false);
    const p2 = await t.post([c.id]);
    const r = await resolvePublishMedia(t.scope, p2.targets[0]!.id, insta);
    expect(r).toEqual({ ok: false, error: "Image 1 is no longer available." });
  });
});
