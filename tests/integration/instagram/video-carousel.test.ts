// US4: a carousel mixing images and videos publishes through the step machine; every video item is polled first.
// Mocked Graph only; the DB clock is pinned with `atTime`, never slept.
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { allowanceUses } from "../../../src/server/db/schema/scheduler";
import { postTargets } from "../../../src/server/db/schema/posts";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { runTick } from "../../../src/server/scheduler";
import { setStorageForTests } from "../../../src/server/storage";
import { atTime } from "../../helpers/clock";
import { closeDb, testDb } from "../../helpers/db";
import { createFakeGraph, type FakeGraph, type GraphReply } from "../../helpers/fake-graph";
import { IG_ID, instagramVideoSetup } from "../../helpers/instagram-publish";
import { parkAllDueTargets } from "../../helpers/scheduling";
import { createMemoryStorage, type MemoryStorage } from "../../helpers/storage";

let graph: FakeGraph;
let storage: MemoryStorage;
beforeEach(async () => {
  await parkAllDueTargets();
  graph = createFakeGraph().install();
  storage = createMemoryStorage();
  setStorageForTests(storage);
});
afterEach(() => graph.uninstall());
afterAll(async () => {
  setStorageForTests(undefined);
  await closeDb();
});

const media = `/v26.0/${IG_ID}/media`;
const quota = `/v26.0/${IG_ID}/content_publishing_limit`;
const publish = `/v26.0/${IG_ID}/media_publish`;
const T0 = Date.now() + 60_000;
const tickAt = (seconds: number) => atTime(new Date(T0 + seconds * 1000), async () => (await runTick({ config: {} })).publishing.counts);

const creates = () => graph.requests.filter((r) => r.method === "POST" && r.path === media);
const publishes = () => graph.requests.filter((r) => r.path === publish);
const readsOf = (id: string) => graph.requests.filter((r) => r.method === "GET" && r.path === `/v26.0/${id}`);
const quotaOk: GraphReply = { kind: "ok", body: { data: [{ quota_usage: 3, config: { quota_total: 100 } }] } };
const inProgress: GraphReply = { kind: "ok", body: { status_code: "IN_PROGRESS" } };
const finished: GraphReply = { kind: "ok", body: { status_code: "FINISHED" } };
const expired: GraphReply = { kind: "ok", body: { status_code: "EXPIRED" } };

function scriptCreates() {
  let n = 0;
  graph.on("POST", media, () => ({ kind: "ok", body: { id: `r${++n}` } }));
  graph.on("GET", quota, quotaOk);
  graph.on("POST", publish, { kind: "ok", body: { id: "ig_carousel_1" } });
}

/** Tick every `stepSeconds` until `stop` holds or `limit` seconds pass; returns the last second ticked. */
async function drive(stop: () => Promise<boolean> | boolean, stepSeconds = 61, limit = 3 * 3600) {
  let s = 0;
  for (; s <= limit; s += stepSeconds) {
    await tickAt(s);
    if (await stop()) break;
  }
  return s;
}

describe("a carousel with videos through the real scheduler", () => {
  it("image, video, image: items in order, the video polled before the carousel, one publish", async () => {
    scriptCreates();
    graph.on("GET", "/v26.0/r2", [inProgress, finished]);
    graph.on("GET", "/v26.0/r4", [inProgress, finished]);
    const { row } = await instagramVideoSetup(storage, "mixed", ["image", "video", "image"]);
    await drive(async () => (await row()).status === "published");
    expect(await row()).toMatchObject({ status: "published", externalId: "ig_carousel_1" });
    const c = creates();
    expect(c).toHaveLength(4);
    expect(c[0]!.params.image_url).toBeTruthy();
    expect(c[1]!.params.video_url).toBeTruthy();
    expect(c[2]!.params.image_url).toBeTruthy();
    expect(c[3]!.params).toMatchObject({ media_type: "CAROUSEL", children: "r1,r2,r3", caption: "mixed" });
    for (const item of c.slice(0, 3)) expect(item.params).toMatchObject({ is_carousel_item: "true" });
    // A Reel is never a carousel item.
    for (const item of c.slice(0, 3)) expect(item.params.media_type).toBeUndefined();
    expect(readsOf("r2")).toHaveLength(2);
    expect(readsOf("r2")[0]!.params.fields).toBe("status_code,status");
    expect(graph.requests.indexOf(readsOf("r2")[1]!)).toBeLessThan(graph.requests.indexOf(c[3]!));
    expect(readsOf("r4")).toHaveLength(2);
    expect(publishes()).toHaveLength(1);
  });

  it("an all-video carousel polls every item before the carousel is created", async () => {
    scriptCreates();
    graph.on("GET", "/v26.0/r1", finished);
    graph.on("GET", "/v26.0/r2", [inProgress, finished]);
    graph.on("GET", "/v26.0/r3", finished);
    const { row } = await instagramVideoSetup(storage, "reels", ["video", "video"]);
    await drive(async () => (await row()).status === "published");
    const c = creates();
    expect(c).toHaveLength(3);
    expect(c[2]!.params).toMatchObject({ media_type: "CAROUSEL", children: "r1,r2" });
    for (const id of ["r1", "r2"]) {
      expect(readsOf(id).length).toBeGreaterThan(0);
      expect(graph.requests.indexOf(readsOf(id).at(-1)!)).toBeLessThan(graph.requests.indexOf(c[2]!));
    }
    expect(publishes()).toHaveLength(1);
  });

  it("an item ERROR fails naming item 2, and the carousel is never created", async () => {
    scriptCreates();
    graph.on("GET", "/v26.0/r2", { kind: "ok", body: { status_code: "ERROR", status: "Unsupported codec" } });
    const { row } = await instagramVideoSetup(storage, "bad", ["image", "video", "image"]);
    await drive(async () => (await row()).status === "failed");
    const r = await row();
    expect(r.status).toBe("failed");
    expect(r.lastError).toContain("video 2 of the carousel (item 2): Unsupported codec");
    expect(creates()).toHaveLength(3);
    expect(publishes()).toHaveLength(0);
  });

  it("an item EXPIRED rebuilds from item 1 twice, then fails", async () => {
    scriptCreates();
    for (const id of ["r2", "r5", "r8"]) graph.on("GET", `/v26.0/${id}`, expired);
    const { row } = await instagramVideoSetup(storage, "again", ["image", "video", "image"]);
    await drive(async () => (await row()).status === "failed");
    const r = await row();
    expect(r.status).toBe("failed");
    expect(r.lastError).toContain("tried 3 times");
    expect(creates()).toHaveLength(9);
    expect(publishes()).toHaveLength(0);
  });

  it("the 23 h guard rebuilds from item 1, measured from the oldest container", async () => {
    scriptCreates();
    graph.on("GET", "/v26.0/r2", finished);
    graph.on("GET", "/v26.0/r4", finished);
    await instagramVideoSetup(storage, "slow", ["image", "video", "image"]);
    // Three item creates, the video item check, the carousel create and its check: the carousel is ready.
    for (let i = 0; i < 6; i++) await tickAt(i * 61);
    expect(creates()).toHaveLength(4);
    // The next step is the quota check, 23 hours after the first item was created: the containers are too old.
    await tickAt(23 * 3600 + 600); // rebuild: back to the first create step
    expect(creates()).toHaveLength(4);
    await tickAt(23 * 3600 + 661);
    expect(creates()).toHaveLength(5);
    expect(creates()[4]!.params.is_carousel_item).toBe("true"); // the rebuild starts at item 1
    expect(publishes()).toHaveLength(0);
  });

  it("11 items are refused before any request", async () => {
    scriptCreates();
    const { row } = await instagramVideoSetup(storage, "too many", Array.from({ length: 11 }, () => "image" as const));
    await tickAt(0);
    await tickAt(61);
    expect(creates()).toHaveLength(0);
    expect((await row()).status).not.toBe("published");
  });

  it("the carousel container holding a video returning ERROR fails with the detail and no publish", async () => {
    scriptCreates();
    graph.on("GET", "/v26.0/r2", finished);
    graph.on("GET", "/v26.0/r4", { kind: "ok", body: { status_code: "ERROR", status: "Error: bad item" } });
    const { projectId, targetId, row } = await instagramVideoSetup(storage, "bad carousel", ["image", "video", "image"]);
    await drive(async () => (await row()).status === "failed");
    const r = await row();
    expect(r.status).toBe("failed");
    expect(r.lastError).toContain("Instagram could not process the carousel: Error: bad item");
    expect(publishes()).toHaveLength(0);
    const attempts = await forSchedulerProject(projectId).attempts.listForTarget(targetId);
    expect(JSON.stringify(attempts)).toContain('"statusDetail":"Error: bad item"');
  });

  it("a check_item_2 killed mid-flight is retried: nothing more is charged and exactly one publish", async () => {
    scriptCreates();
    graph.on("GET", "/v26.0/r2", [inProgress, finished]);
    graph.on("GET", "/v26.0/r4", finished);
    const { projectId, targetId, row } = await instagramVideoSetup(storage, "killed carousel", ["image", "video", "image"]);
    let s = 0;
    for (; creates().length < 3; s += 61) await tickAt(s);
    const past = new Date(T0 + s * 1000 - 60_000);
    await testDb()
      .update(postTargets)
      .set({ status: "publishing", leaseOwner: randomUUID(), leaseUntil: past, inFlightStep: "check_item_2", inFlightMayPublish: false, firstStepAt: past })
      .where(and(eq(postTargets.projectId, projectId), eq(postTargets.id, targetId)));
    expect(await tickAt(s)).toMatchObject({ recovered: 1, ambiguous: 0 });
    for (s += 61; s < 3 * 3600 && (await row()).status !== "published"; s += 61) await tickAt(s);
    expect(await row()).toMatchObject({ status: "published", externalId: "ig_carousel_1" });
    expect(publishes()).toHaveLength(1);
    const units = (await testDb().select().from(allowanceUses).where(eq(allowanceUses.projectId, projectId))).map((u) => u.units);
    expect(units).toEqual([4]); // reserved once up front (three items and the carousel); a retried check is not a create, so it adds none
  });
});
