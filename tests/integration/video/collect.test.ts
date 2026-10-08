import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { crossProject, forJobRunner } from "../../../src/server/dal/scope";
import { postTargets, videoVersions } from "../../../src/server/db/schema";
import { collectVideoVersions } from "../../../src/server/scheduler/housekeeping";
import { deleteMedia } from "../../../src/server/services/media";
import { setStorageForTests } from "../../../src/server/storage";
import { closeDb, testDb } from "../../helpers/db";
import { markReady, queueVersionFor, strictVideoProvider, videoTargetSetup } from "../../helpers/video-publish-setup";

const HOUR = 3_600_000;
const STALE_KEY = "f".repeat(64);

afterAll(async () => {
  setStorageForTests(undefined);
  await closeDb();
});
afterEach(() => setStorageForTests(undefined));
beforeEach(async () => {
  // Collection is cross-project: remove rows an earlier file left behind so the batch is ours.
  await crossProject("test: clear video versions", async () => await testDb().delete(videoVersions));
});

/** A project whose one 1080p clip needs adapting for the strict target, with its wanted version ready and stored. */
async function setup() {
  const t = await videoTargetSetup({ width: 1920, height: 1080, durationSeconds: 5, frameRate: 30 }, false, "spy-video-strict");
  const { version } = await queueVersionFor(t, strictVideoProvider);
  await t.storage.put(`${t.project.id}/wanted.mp4`, Buffer.from("w"), "video/mp4");
  await markReady(t.project.id, version.id, `${t.project.id}/wanted.mp4`, "https://x/wanted.mp4");
  return { ...t, version };
}

/** An unwanted ready version with a stored object. */
const age = (t: { project: { id: string } }, id: string, hours: number) =>
  testDb().update(videoVersions).set({ requestedAt: new Date(Date.now() - hours * HOUR) }).where(scoped(t.project.id, id));
const findIn = async (t: { project: { id: string } }, id: string) =>
  (await testDb().select().from(videoVersions).where(scoped(t.project.id, id)))[0];

async function addStale(t: Awaited<ReturnType<typeof setup>>) {
  const [row] = await t.repos.videoVersions.ensureQueued([
    { assetId: t.asset.id, kind: "full", key: STALE_KEY, recipe: t.version.recipe as never, steps: [], dueAt: null },
  ]);
  await t.storage.put(`${t.project.id}/stale.mp4`, Buffer.from("s"), "video/mp4");
  await markReady(t.project.id, row!.id, `${t.project.id}/stale.mp4`, "https://x/stale.mp4");
  return row!;
}

const scoped = (projectId: string, id: string) => and(eq(videoVersions.projectId, projectId), eq(videoVersions.id, id));

describe("collecting video versions", () => {
  it("removes an unwanted stale version with its object and keeps the wanted one, marked checked", async () => {
    const t = await setup();
    const stale = await addStale(t);
    await age(t, t.version.id, 25);
    await age(t, stale.id, 25);
    expect(await collectVideoVersions()).toBe(1);
    expect(await findIn(t, stale.id)).toBeUndefined();
    expect(t.storage.objects.has(`${t.project.id}/stale.mp4`)).toBe(false);
    expect((await findIn(t, t.version.id))?.checkedAt).not.toBeNull();
    expect(t.storage.objects.has(`${t.project.id}/wanted.mp4`)).toBe(true);
    // Checked just now, so it is not looked at again for a day.
    expect(await collectVideoVersions()).toBe(0);
  });

  it("keeps an unwanted version that was asked for within the last 24 hours", async () => {
    const t = await setup();
    const stale = await addStale(t);
    await age(t, stale.id, 23);
    expect(await collectVideoVersions()).toBe(0);
    expect(await findIn(t, stale.id)).toBeDefined();
  });

  it("never touches a building row", async () => {
    const t = await setup();
    const stale = await addStale(t);
    await testDb()
      .update(videoVersions)
      .set({ state: "building", leaseToken: "00000000-0000-4000-8000-000000000001", leaseUntil: new Date(Date.now() + HOUR), storageKey: null, publicUrl: null })
      .where(scoped(t.project.id, stale.id));
    await age(t, stale.id, 48);
    expect(await collectVideoVersions()).toBe(0);
    expect(await findIn(t, stale.id)).toBeDefined();
  });

  it("removes every version and object with the deleted video", async () => {
    const t = await setup();
    const stale = await addStale(t);
    await testDb().update(postTargets).set({ status: "draft" }).where(eq(postTargets.projectId, t.project.id));
    const scope = await forJobRunner(t.project.id, null);
    await deleteMedia(scope, t.asset.id);
    expect(await findIn(t, t.version.id)).toBeUndefined();
    expect(await findIn(t, stale.id)).toBeUndefined();
    expect(t.storage.objects.has(`${t.project.id}/wanted.mp4`)).toBe(false);
    expect(t.storage.objects.has(`${t.project.id}/stale.mp4`)).toBe(false);
  });
});
