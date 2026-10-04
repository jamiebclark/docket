import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ConflictError } from "../../../src/server/dal/errors";
import * as media from "../../../src/server/services/media";
import * as posts from "../../../src/server/services/posts";
import { setStorageForTests } from "../../../src/server/storage";
import { closeDb } from "../../helpers/db";
import { png } from "../../helpers/images";
import { postsEnv } from "../../helpers/posts-env";
import { createMemoryStorage } from "../../helpers/storage";

afterAll(async () => {
  setStorageForTests(undefined);
  await closeDb();
});
afterEach(() => setStorageForTests(undefined));

const LIVE = { scheduleKind: "explicit", scheduledAt: new Date("2030-01-01T00:00:00Z"), nextAttemptAt: new Date("2030-01-01T00:00:00Z") } as const;

async function setup() {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  const env = await postsEnv();
  const up = await media.uploadMedia(env.scope, { file: { name: "a.png", bytes: await png(100, 100) } });
  if (!up.ok) throw new Error("upload failed");
  const account = await env.account();
  const draft = await posts.createDraft(env.scope, {
    baseText: "hello",
    targets: [{ accountId: account.id }],
    mediaIds: [up.asset.id],
  });
  return { ...env, storage, asset: up.asset, account, draft };
}

describe("deleteMedia", () => {
  it("allows a draft, detaches it, soft-deletes and removes objects after commit", async () => {
    const t = await setup();
    const impact = await media.deleteMediaImpact(t.scope, t.asset.id);
    expect(impact.blocked).toEqual([]);
    expect(impact.affected.map((a) => a.postId)).toEqual([t.draft.post.id]);
    const res = await media.deleteMedia(t.scope, t.asset.id);
    expect(res.affected).toHaveLength(1);
    expect(t.storage.objects.size).toBe(0);
    expect(await t.scope.media.get(t.asset.id)).toBeNull();
    expect((await t.scope.media.getIncludingDeleted(t.asset.id))?.deletedAt).not.toBeNull();
    expect(await t.scope.posts.listMediaIds(t.draft.post.id)).toEqual([]);
    await expect(media.getMedia(t.scope, t.asset.id)).rejects.toThrow();
    // idempotent
    await expect(media.deleteMedia(t.scope, t.asset.id)).resolves.toEqual({ affected: [] });
  });

  it("removes the asset's variants and their objects", async () => {
    const t = await setup();
    const key = `projects/${t.project.id}/media/variant-test.jpg`;
    await t.storage.put(key, Buffer.from("x"), "image/jpeg");
    await t.scope.media.insertVariant({
      mediaAssetId: t.asset.id,
      constraintsHash: "h",
      storageKey: key,
      publicUrl: t.storage.publicUrl(key),
      mimeType: "image/jpeg",
      width: 1,
      height: 1,
      byteSize: 1,
      steps: [],
    });
    const variants = await t.scope.media.listVariants(t.asset.id);
    expect(variants.length).toBeGreaterThan(0);
    for (const v of variants) expect(await t.storage.exists(v.storageKey)).toBe(true);
    await media.deleteMedia(t.scope, t.asset.id);
    expect(await t.scope.media.listVariants(t.asset.id)).toHaveLength(0);
    for (const v of variants) expect(await t.storage.exists(v.storageKey)).toBe(false);
  });

  it.each(["scheduled", "failed", "ambiguous", "publishing"] as const)("refuses when a target is %s", async (status) => {
    const t = await setup();
    const [target] = await t.scope.targets.listForPost(t.draft.post.id);
    await t.scope.targets.update(target!.id, { status, ...LIVE });
    const impact = await media.deleteMediaImpact(t.scope, t.asset.id);
    expect(impact.blocked.map((b) => b.postId)).toEqual([t.draft.post.id]);
    await expect(media.deleteMedia(t.scope, t.asset.id)).rejects.toBeInstanceOf(ConflictError);
    expect(await t.scope.media.get(t.asset.id)).not.toBeNull();
    expect(t.storage.objects.size).toBe(2);
  });

  it("keeps published history pointing at the deleted asset", async () => {
    const t = await setup();
    const [target] = await t.scope.targets.listForPost(t.draft.post.id);
    await t.scope.targets.update(target!.id, { status: "published", externalId: "ext-1" });
    await media.deleteMedia(t.scope, t.asset.id);
    expect(await t.scope.posts.listMediaIds(t.draft.post.id)).toEqual([t.asset.id]);
    expect(await t.scope.media.get(t.asset.id)).toBeNull();
    expect((await t.scope.media.getIncludingDeleted(t.asset.id))?.deletedAt).not.toBeNull();
  });

  it("logs object-delete failures without secrets and still succeeds", async () => {
    const t = await setup();
    t.storage.delete = async () => {
      throw new Error("secret-token-xyz");
    };
    const logged: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void logged.push(a.join(" "));
    try {
      await media.deleteMedia(t.scope, t.asset.id);
    } finally {
      console.error = orig;
    }
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.join("\n")).not.toContain("secret-token-xyz");
  });

  it("serialises a concurrent delete and attach: one wins, no deadlock", async () => {
    const t = await setup();
    const other = await posts.createDraft(t.scope, { baseText: "other", targets: [{ accountId: t.account.id }], mediaIds: [] });
    const results = await Promise.allSettled([
      media.deleteMedia(t.scope, t.asset.id),
      posts.updatePost(t.scope, other.post.id, { mediaIds: [t.asset.id] }),
    ]);
    const deleted = (await t.scope.media.get(t.asset.id)) === null;
    const attached = (await t.scope.posts.listMediaIds(other.post.id)).includes(t.asset.id);
    expect(results.every((r) => r.status === "fulfilled" || r.reason)).toBe(true);
    // Never both: a deleted asset is not attached to a live draft.
    expect(deleted && attached).toBe(false);
  });
});
