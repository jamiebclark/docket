import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const forceMismatch = vi.hoisted(() => ({ on: false }));
vi.mock("../../../src/server/video/readback", async (orig) => {
  const real = await orig<typeof import("../../../src/server/video/readback")>();
  return { ...real, readBack: async (...a: Parameters<typeof real.readBack>) => (forceMismatch.on ? { ok: false as const, mismatch: "forced" } : real.readBack(...a)) };
});

import { crossProject } from "../../../src/server/dal/scope";
import { videoVersions } from "../../../src/server/db/schema";
import { setStorageForTests } from "../../../src/server/storage";
import { markWorkerProcess } from "../../../src/server/video/guard";
import { buildNext } from "../../../src/server/video/versions-loop";
import { closeDb, testDb } from "../../helpers/db";
import { createVideoAsset } from "../../helpers/factories";
import { requireFfmpeg } from "../../helpers/ffmpeg";
import { queueVersionFor, strictVideoProvider, videoTargetSetup } from "../../helpers/video-publish-setup";
import { videoRecipeKey } from "../../../src/server/media/hash";
import { previewRecipe } from "../../../src/providers/video-plan";
import { createVideoFixtures, type VideoFixtures } from "../../helpers/video-fixtures";

const signal = new AbortController().signal;

afterAll(async () => {
  setStorageForTests(undefined);
  await closeDb();
});
afterEach(() => {
  forceMismatch.on = false;
  setStorageForTests(undefined);
});

requireFfmpeg()("the version worker loop", () => {
  let fx: VideoFixtures;
  beforeAll(() => {
    fx = createVideoFixtures();
  });
  afterAll(() => fx?.cleanup());
  beforeEach(async () => {
    markWorkerProcess();
    // The claim is cross-project: remove anything an earlier file left waiting.
    await crossProject("test: clear waiting versions", async () =>
      await testDb().delete(videoVersions).where(eq(videoVersions.state, "queued")),
    );
  });

  /** A project whose one asset is the real 320x180 landscape clip, and a version of it queued for the strict target. */
  async function queued() {
    const t = await videoTargetSetup({ width: 320, height: 180, durationSeconds: 2, frameRate: 15, byteSize: readFileSync(fx.landscape).length }, false, "spy-video-strict");
    await t.storage.put(t.asset.storageKey, readFileSync(fx.landscape), "video/mp4");
    const { version } = await queueVersionFor(t, strictVideoProvider);
    return { ...t, version };
  }
  const rowOf = async (projectId: string, id: string) =>
    (await testDb().select().from(videoVersions).where(and(eq(videoVersions.projectId, projectId), eq(videoVersions.id, id))))[0]!;
  const versionKeys = (t: { storage: { objects: Map<string, unknown> } }) => [...t.storage.objects.keys()].filter((k) => k.includes("/vv/"));

  it("builds one version once when two lanes race for it", async () => {
    const t = await queued();
    const results = await Promise.all([buildNext({ signal }), buildNext({ signal })]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const row = await rowOf(t.project.id, t.version.id);
    expect(row).toMatchObject({ state: "ready", attempts: 1 });
    expect(versionKeys(t)).toEqual([row.storageKey]);
  });

  it("takes over a build whose worker died and stores no partial object", async () => {
    const t = await queued();
    await testDb()
      .update(videoVersions)
      .set({ state: "building", attempts: 1, leaseToken: "00000000-0000-4000-8000-000000000001", leaseUntil: new Date(Date.now() - 60_000) })
      .where(and(eq(videoVersions.projectId, t.project.id), eq(videoVersions.id, t.version.id)));
    expect(await buildNext({ signal })).toBe(true);
    const row = await rowOf(t.project.id, t.version.id);
    expect(row).toMatchObject({ state: "ready", attempts: 2 });
    expect(versionKeys(t)).toEqual([row.storageKey]);
  });

  it("stores nothing for a deleted asset", async () => {
    const t = await queued();
    await t.repos.media.softDelete(t.asset.id, new Date());
    expect(await buildNext({ signal })).toBe(false);
    expect(versionKeys(t)).toEqual([]);
    expect(await rowOf(t.project.id, t.version.id)).toMatchObject({ state: "queued", storageKey: null });
  });

  it("fails after 3 attempts when the output never matches the plan, and is never ready", async () => {
    forceMismatch.on = true;
    const t = await queued();
    for (let i = 0; i < 5; i++) if (!(await buildNext({ signal }))) break;
    const row = await rowOf(t.project.id, t.version.id);
    expect(row).toMatchObject({ state: "failed", attempts: 3, storageKey: null });
    expect(row.error).toBe("The adapted video did not match what was planned.");
    expect(versionKeys(t)).toEqual([]);
  });

  it("is not blocked by an unrelated ready asset", async () => {
    const t = await queued();
    await createVideoAsset(t.project.id, {});
    expect(await buildNext({ signal })).toBe(true);
  });

  it("builds a preview: long side at most 640, the planned duration, audio kept", async () => {
    const t = await queued();
    const { plan } = await queueVersionFor(t, strictVideoProvider);
    const recipe = previewRecipe(plan.recipe, 15);
    await t.repos.videoVersions.ensureQueued([{ assetId: t.asset.id, kind: "preview", key: videoRecipeKey("preview", recipe), recipe, steps: plan.steps, dueAt: new Date() }]);
    // Build until the preview is done: a queued full version may run first.
    for (let i = 0; i < 2; i++) await buildNext({ signal });
    const [row] = await t.repos.videoVersions.getPreviewsByKeys([videoRecipeKey("preview", recipe)]);
    expect(row).toMatchObject({ state: "ready", container: "mp4" });
    expect(Math.max(row!.width!, row!.height!)).toBeLessThanOrEqual(640);
    expect(Math.abs(row!.durationMs! - recipe.keptMs)).toBeLessThanOrEqual(500);
    expect(row!.audioCodec).not.toBeNull();
    expect(row!.storageKey).toContain("/vp/");
  });
});
