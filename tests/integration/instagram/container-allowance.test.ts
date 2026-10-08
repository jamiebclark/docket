// US5: Instagram's 400 containers per rolling 24 h, reserved when a create step is leased (contracts/creation-allowance.md).
// Mocked Graph only; the DB clock is pinned with `atTime`, never slept.
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { allowanceUses } from "../../../src/server/db/schema/scheduler";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { runTick } from "../../../src/server/scheduler";
import { createSchedulingRepos } from "../../../src/server/dal/scope";
import { setStorageForTests } from "../../../src/server/storage";
import { atTime } from "../../helpers/clock";
import { closeDb, testDb } from "../../helpers/db";
import { createVideoAsset } from "../../helpers/factories";
import { createFakeGraph, type FakeGraph } from "../../helpers/fake-graph";
import { IG_ID, instagramSetup, instagramVideoSetup } from "../../helpers/instagram-publish";
import { createDueTarget, parkAllDueTargets } from "../../helpers/scheduling";
import { createMemoryStorage, type MemoryStorage } from "../../helpers/storage";

let graph: FakeGraph;
let storage: MemoryStorage;
beforeEach(async () => {
  await parkAllDueTargets();
  graph = createFakeGraph().install();
  storage = createMemoryStorage();
  setStorageForTests(storage);
  let n = 0;
  graph.on("POST", media, () => ({ kind: "ok", body: { id: `c${++n}` } }));
  graph.fallback({ kind: "ok", body: { status_code: "IN_PROGRESS" } });
});
afterEach(() => graph.uninstall());
afterAll(async () => {
  setStorageForTests(undefined);
  await closeDb();
});

const media = `/v26.0/${IG_ID}/media`;
const DAY = 86_400_000;
const T0 = Date.now() + 3_600_000;
const at = (seconds: number) => new Date(T0 + seconds * 1000);
const tickAt = (seconds: number) => atTime(at(seconds), async () => (await runTick({ config: {} })).publishing.counts);
const creates = () => graph.requests.filter((r) => r.method === "POST" && r.path === media);

async function seed(projectId: string, accountId: string, rows: readonly { units: number; ageSeconds: number }[]) {
  await testDb()
    .insert(allowanceUses)
    .values(rows.map((r) => ({ projectId, socialAccountId: accountId, units: r.units, createdAt: at(-r.ageSeconds) })));
}
const rowsOf = async (projectId: string, accountId: string) =>
  (await testDb().select().from(allowanceUses).where(and(eq(allowanceUses.projectId, projectId), eq(allowanceUses.socialAccountId, accountId)))).sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  );
const used = async (projectId: string, accountId: string) => (await rowsOf(projectId, accountId)).reduce((n, r) => n + r.units, 0);

/** Another due single-video target on the same account (one tick-second later than the setup's). */
async function addVideoTarget(base: { projectId: string; accountId: string }, text: string) {
  const { post, target } = await createDueTarget(base.projectId, base.accountId, { baseText: text, dueAt: at(-30), patch: { chosenPostType: "reel" } });
  const video = await createVideoAsset(base.projectId, { width: 720, height: 1280, durationSeconds: 20 });
  await storage.put(video.storageKey, Buffer.from("not really a video"), "video/mp4");
  await createSchedulingRepos(testDb(), base.projectId).posts.setMedia(post.id, [video.id]);
  return target;
}

describe("the 400-container allowance", () => {
  it("399 used lets one video create, and a second due target waits with no Graph request", async () => {
    const base = await instagramVideoSetup(storage, "first", ["video"], { postType: "reel" });
    const second = await addVideoTarget(base, "second");
    await seed(base.projectId, base.accountId, [{ units: 399, ageSeconds: 3600 }]);
    const counts = await tickAt(0);
    expect(counts).toMatchObject({ claimed: 2, continued: 1, deferred: 1 });
    expect(creates()).toHaveLength(1);
    expect(await used(base.projectId, base.accountId)).toBe(400);

    const repos = forSchedulerProject(base.projectId);
    const waiting = [await repos.targets.get(base.targetId), await repos.targets.get(second.id)].find((t) => t!.lastError?.startsWith("Waiting for"))!;
    expect(waiting.lastError).toBe("Waiting for Instagram's daily container allowance (400 of 400 used in the last 24 hours); nothing was created.");
    expect(waiting.attemptCount).toBe(0);
    expect(waiting.nextAttemptAt!.getTime()).toBe(at(-3600).getTime() + DAY + 1000);
    expect((await repos.attempts.listForTarget(waiting.id)).map((a) => a.outcome)).toEqual(["deferred"]);
  });

  it("390 used defers a 10-item carousel needing 11 until the window has passed", async () => {
    const base = await instagramVideoSetup(storage, "ten", Array.from({ length: 10 }, () => "image" as const));
    await seed(base.projectId, base.accountId, [{ units: 390, ageSeconds: 3600 }]);
    expect(await tickAt(0)).toMatchObject({ claimed: 1, deferred: 1 });
    expect(creates()).toHaveLength(0);
    expect(await used(base.projectId, base.accountId)).toBe(390);
    expect((await base.row()).nextAttemptAt!.getTime()).toBe(at(-3600).getTime() + DAY + 1000);

    expect(await tickAt(-3600 + 86_400 + 2)).toMatchObject({ claimed: 1, continued: 1 });
    expect(creates()).toHaveLength(1);
    expect((await rowsOf(base.projectId, base.accountId)).map((r) => r.units)).toEqual([390, 11]);
  });

  it("two due targets with room for one create exactly one", async () => {
    const base = await instagramVideoSetup(storage, "a", ["video"], { postType: "reel" });
    await addVideoTarget(base, "b");
    await seed(base.projectId, base.accountId, [{ units: 399, ageSeconds: 60 }]);
    await tickAt(0);
    expect(creates()).toHaveLength(1);
    expect(await used(base.projectId, base.accountId)).toBe(400);
  });

  it("two concurrent ticks never take the account past 400", async () => {
    const base = await instagramVideoSetup(storage, "a", ["video"], { postType: "reel" });
    await addVideoTarget(base, "b");
    await addVideoTarget(base, "c");
    await seed(base.projectId, base.accountId, [{ units: 398, ageSeconds: 60 }]);
    await atTime(at(0), () => Promise.all([runTick({ config: {} }), runTick({ config: {} })]));
    expect(await used(base.projectId, base.accountId)).toBeLessThanOrEqual(400);
    expect(creates()).toHaveLength(2);
  });

  it("an EXPIRED rebuild reserves the need again", async () => {
    graph.on("GET", "/v26.0/c1", { kind: "ok", body: { status_code: "EXPIRED" } });
    const base = await instagramSetup(storage, "again", 1);
    await tickAt(0); // create
    expect(await tickAt(11)).toMatchObject({ claimed: 1, continued: 1 }); // EXPIRED → recreate
    await tickAt(12); // second create
    expect(creates()).toHaveLength(2);
    expect((await rowsOf(base.projectId, base.accountId)).map((r) => r.units)).toEqual([1, 1]);
  });

  it("a retried create reserves 1, not the whole need", async () => {
    graph.on("POST", media, [{ kind: "http", status: 503 }, { kind: "ok", body: { id: "c9" } }]);
    const base = await instagramVideoSetup(storage, "retry", ["image", "image", "image"]);
    await tickAt(0);
    expect((await rowsOf(base.projectId, base.accountId)).map((r) => r.units)).toEqual([4]);
    expect((await base.row()).attemptCount).toBe(1);
    await tickAt(3600);
    expect((await rowsOf(base.projectId, base.accountId)).map((r) => r.units)).toEqual([4, 1]);
  });

  it("image targets count too", async () => {
    const base = await instagramSetup(storage, "pic", 1);
    await tickAt(0);
    expect(await used(base.projectId, base.accountId)).toBe(1);
  });

  it("a rate-limit refusal on create is a retryable wait, not a failure (FR-021)", async () => {
    graph.on("POST", media, { kind: "graph_error", code: 4, message: "Too many calls", status: 400 });
    const base = await instagramSetup(storage, "limited", 1);
    expect(await tickAt(0)).toMatchObject({ claimed: 1, retried: 1 });
    const after = await base.row();
    expect(after.status).not.toBe("failed");
    expect(after.attemptCount).toBe(1);
    expect(after.nextAttemptAt!.getTime()).toBeGreaterThan(at(0).getTime());
  });
});
