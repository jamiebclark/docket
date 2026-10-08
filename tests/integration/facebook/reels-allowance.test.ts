// US3: Facebook's 30 Reels per rolling 24 h, reserved when start_reel is leased (G22).
// Mocked Graph only; the DB clock is pinned with `atTime`, never slept.
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { allowanceUses } from "../../../src/server/db/schema/scheduler";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { createSchedulingRepos } from "../../../src/server/dal/scope";
import { runTick } from "../../../src/server/scheduler";
import { setStorageForTests } from "../../../src/server/storage";
import { atTime } from "../../helpers/clock";
import { closeDb, testDb } from "../../helpers/db";
import { createVideoAsset } from "../../helpers/factories";
import { facebookSetup, facebookVideoSetup, PAGE_ID } from "../../helpers/facebook-publish";
import { createFakeGraph, type FakeGraph } from "../../helpers/fake-graph";
import { createDueTarget, parkAllDueTargets } from "../../helpers/scheduling";
import { createMemoryStorage, type MemoryStorage } from "../../helpers/storage";

let graph: FakeGraph;
let storage: MemoryStorage;
beforeEach(async () => {
  await parkAllDueTargets();
  graph = createFakeGraph().install();
  storage = createMemoryStorage();
  setStorageForTests(storage);
  graph.on("POST", reels, (req) =>
    req.params.upload_phase === "start"
      ? { kind: "ok", body: { video_id: "77", upload_url: "https://rupload.facebook.com/video-upload/77" } }
      : { kind: "ok", body: { success: true } },
  );
  graph.on("POST", `/v26.0/${PAGE_ID}/videos`, { kind: "ok", body: { id: "88" } });
  graph.on("POST", `/v26.0/${PAGE_ID}/feed`, { kind: "ok", body: { id: `${PAGE_ID}_1` } });
  graph.on("POST", `/v26.0/${PAGE_ID}/photos`, { kind: "ok", body: { id: "p1", post_id: `${PAGE_ID}_2` } });
  graph.fallback({ kind: "ok", body: { id: "x", status: { video_status: "upload_in_progress", uploading_phase: { status: "in_progress" } } } });
});
afterEach(() => graph.uninstall());
afterAll(async () => {
  setStorageForTests(undefined);
  await closeDb();
});

const reels = `/v26.0/${PAGE_ID}/video_reels`;
const DAY = 86_400_000;
const T0 = Date.now() + 3_600_000;
const at = (seconds: number) => new Date(T0 + seconds * 1000);
const tickAt = (seconds: number) => atTime(at(seconds), async () => (await runTick({ config: {} })).publishing.counts);
const starts = () => graph.requests.filter((r) => r.method === "POST" && r.path === reels && r.params.upload_phase === "start");

async function seed(projectId: string, accountId: string, units: number, ageSeconds = 3600) {
  await testDb().insert(allowanceUses).values({ projectId, socialAccountId: accountId, units, createdAt: at(-ageSeconds) });
}
const used = async (projectId: string, accountId: string) =>
  (await testDb().select().from(allowanceUses).where(and(eq(allowanceUses.projectId, projectId), eq(allowanceUses.socialAccountId, accountId)))).reduce(
    (n, r) => n + r.units,
    0,
  );

/** Another due Reel target on the same account. */
async function addReelTarget(base: { projectId: string; accountId: string }, text: string) {
  const { post, target } = await createDueTarget(base.projectId, base.accountId, { baseText: text, dueAt: at(-30), patch: { chosenPostType: "reel" } });
  const video = await createVideoAsset(base.projectId, { width: 1080, height: 1920, durationSeconds: 20 });
  await storage.put(video.storageKey, Buffer.from("not really a video"), "video/mp4");
  await createSchedulingRepos(testDb(), base.projectId).posts.setMedia(post.id, [video.id]);
  return target;
}

describe("the 30-Reels allowance", () => {
  it("30 used makes the next Reel wait with the G22 message and no request", async () => {
    const base = await facebookVideoSetup(storage, "reel", { postType: "reel", video: { width: 1080, height: 1920 } });
    await seed(base.projectId, base.accountId, 30);
    expect(await tickAt(0)).toMatchObject({ claimed: 1, deferred: 1 });
    expect(graph.requests).toHaveLength(0);
    const row = await base.row();
    expect(row.lastError).toBe("Waiting for Facebook's daily Reels allowance (30 of 30 used in the last 24 hours); nothing was created.");
    expect(row.attemptCount).toBe(0);
    expect(row.nextAttemptAt!.getTime()).toBe(at(-3600).getTime() + DAY + 1000);
    expect((await forSchedulerProject(base.projectId).attempts.listForTarget(base.targetId)).map((a) => a.outcome)).toEqual(["deferred"]);
  });

  it("29 used lets one of two due Reels start", async () => {
    const base = await facebookVideoSetup(storage, "a", { postType: "reel", video: { width: 1080, height: 1920 } });
    await addReelTarget(base, "b");
    await seed(base.projectId, base.accountId, 29);
    await tickAt(0);
    expect(starts()).toHaveLength(1);
    expect(await used(base.projectId, base.accountId)).toBe(30);
  });

  it("concurrent ticks never take the Page past 30", async () => {
    const base = await facebookVideoSetup(storage, "a", { postType: "reel", video: { width: 1080, height: 1920 } });
    await addReelTarget(base, "b");
    await addReelTarget(base, "c");
    await seed(base.projectId, base.accountId, 28);
    await atTime(at(0), () => Promise.all([runTick({ config: {} }), runTick({ config: {} })]));
    expect(await used(base.projectId, base.accountId)).toBeLessThanOrEqual(30);
    expect(starts()).toHaveLength(2);
  });

  it("Page video, photo and text are never held by an exhausted allowance (SC-006)", async () => {
    const video = await facebookVideoSetup(storage, "v", { video: { width: 1920, height: 1080 } });
    const photo = await facebookSetup(storage, "p", 1);
    const text = await facebookSetup(storage, "t", 0);
    for (const b of [video, photo, text]) await seed(b.projectId, b.accountId, 30);
    await tickAt(0);
    expect(starts()).toHaveLength(0);
    for (const b of [video, photo, text]) {
      const row = await b.row();
      expect(row.lastError ?? "").not.toContain("Waiting for");
      expect(row.status).toBe("published");
    }
    expect(await used(video.projectId, video.accountId)).toBe(30);
  });
});
