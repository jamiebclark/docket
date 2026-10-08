import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { runTick } from "../../../src/server/scheduler";
import { setStorageForTests } from "../../../src/server/storage";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { createFakeGraph, type FakeGraph } from "../../helpers/fake-graph";
import { parkAllDueTargets } from "../../helpers/scheduling";
import { createMemoryStorage, type MemoryStorage } from "../../helpers/storage";
import { scriptThreads, THREADS_USER_ID, threadsSetup, threadsVideoSetup, V } from "../../helpers/threads-publish";

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

const T0 = Date.now() + 60_000;
const tickAt = (seconds: number) =>
  atTime(new Date(T0 + seconds * 1000), async () => (await runTick({ config: { providerTimeoutMs: 100 } })).publishing.counts);
const U = THREADS_USER_ID;
const create = `${V}/${U}/threads`;
const publish = `${V}/${U}/threads_publish`;
const quota = `${V}/${U}/threads_publishing_limit`;
const creates = () => graph.requests.filter((r) => r.method === "POST" && r.path === create);
const readsOf = (id: string) => graph.requests.filter((r) => r.method === "GET" && r.path === `${V}/${id}`);
const carousels = () => creates().filter((r) => r.params.media_type === "CAROUSEL");

describe("Threads mixed carousel publishing", () => {
  it("creates image, video, image in order and reads only the video item; no carousel while it is IN_PROGRESS", async () => {
    scriptThreads(graph)
      .create(["1001", "1002", "1003", "1004"])
      .status("1002", ["IN_PROGRESS", "FINISHED"])
      .status("1004", ["FINISHED"])
      .quota(3)
      .publish("th_mix");
    const { row } = await threadsVideoSetup(storage, "mixed", ["image", "video", "image"]);

    for (const s of [0, 1, 2]) expect(await tickAt(s)).toMatchObject({ claimed: 1, continued: 1 });
    expect(creates().map((r) => r.params.media_type)).toEqual(["IMAGE", "VIDEO", "IMAGE"]);
    expect(creates().every((r) => r.params.is_carousel_item === "true")).toBe(true);
    const v = creates()[1]!.params;
    for (const k of ["text", "alt_text", "image_url"]) expect(v).not.toHaveProperty(k);
    expect(v.video_url).toMatch(/\.mp4$/);
    expect(creates()[0]!.params).not.toHaveProperty("text");

    // item 2 was created at T0+1 s, so its first read is due at T0+31 s
    expect((await row()).nextAttemptAt!.getTime() - T0).toBe(31_000);
    expect(await tickAt(30)).toMatchObject({ claimed: 0 });
    expect(await tickAt(32)).toMatchObject({ claimed: 1, continued: 1 }); // IN_PROGRESS
    expect(readsOf("1002")).toHaveLength(1);
    expect((await row()).nextAttemptAt!.getTime() - (T0 + 32_000)).toBe(60_000);
    expect(await tickAt(60)).toMatchObject({ claimed: 0 });
    // SC-006: nothing about the parent, and no image read, while the video item is processing
    expect(carousels()).toHaveLength(0);
    expect(readsOf("1001")).toHaveLength(0);
    expect(readsOf("1003")).toHaveLength(0);

    expect(await tickAt(93)).toMatchObject({ claimed: 1, continued: 1 }); // item 2 FINISHED
    expect(carousels()).toHaveLength(0);
    expect(await tickAt(94)).toMatchObject({ claimed: 1, continued: 1 }); // carousel created
    expect(carousels()).toHaveLength(1);
    expect(carousels()[0]!.params).toMatchObject({ children: "1001,1002,1003", text: "mixed" });
    expect((await row()).nextAttemptAt!.getTime() - (T0 + 94_000)).toBe(30_000);

    expect(await tickAt(125)).toMatchObject({ claimed: 1, continued: 1 }); // parent FINISHED
    expect(readsOf("1004")).toHaveLength(1);
    expect(await tickAt(126)).toMatchObject({ claimed: 1, continued: 1 }); // quota
    expect(graph.requests.filter((r) => r.path === quota)).toHaveLength(1);
    expect(await tickAt(127)).toMatchObject({ claimed: 1, done: 1 });
    const pub = graph.requests.filter((r) => r.path === publish);
    expect(pub).toHaveLength(1);
    expect(pub[0]!.params).toMatchObject({ creation_id: "1004" });
    expect(await row()).toMatchObject({ status: "published", externalId: "th_mix" });
    expect(readsOf("1001")).toHaveLength(0);
    expect(readsOf("1003")).toHaveLength(0);
  });

  it("reads the parent of a video carousel at the video pace (60 s, then 5 minutes past 5 minutes)", async () => {
    scriptThreads(graph)
      .create(["1001", "1002", "1003"])
      .status("1002", ["FINISHED"])
      .status("1003", ["IN_PROGRESS"]);
    const { row } = await threadsVideoSetup(storage, "pace", ["image", "video"]);
    await tickAt(0);
    await tickAt(1);
    await tickAt(32); // item 2 FINISHED
    await tickAt(33); // carousel created, at T0+33 s
    expect(await tickAt(64)).toMatchObject({ continued: 1 }); // parent read, age 31 s
    expect((await row()).nextAttemptAt!.getTime() - (T0 + 64_000)).toBe(60_000);
    expect(await tickAt(340)).toMatchObject({ continued: 1 }); // age 307 s: past 5 minutes
    expect((await row()).nextAttemptAt!.getTime() - (T0 + 340_000)).toBe(300_000);
  });
});

describe("Threads all-video carousel publishing", () => {
  it("reads the second item only after the first finishes", async () => {
    scriptThreads(graph).create(["1001", "1002", "1003"]).status("1001", ["FINISHED"]).status("1002", ["FINISHED"]).status("1003", ["FINISHED"]).quota(3).publish("th_vv");
    const { row } = await threadsVideoSetup(storage, "pair", ["video", "video"]);
    await tickAt(0);
    await tickAt(1);
    expect(readsOf("1002")).toHaveLength(0);
    expect((await row()).nextAttemptAt!.getTime() - T0).toBe(30_000); // the first item is read first
    expect(await tickAt(31)).toMatchObject({ continued: 1 });
    expect(readsOf("1001")).toHaveLength(1);
    expect(readsOf("1002")).toHaveLength(0);
    expect(await tickAt(32)).toMatchObject({ continued: 1 });
    expect(readsOf("1002")).toHaveLength(1);
    expect(carousels()).toHaveLength(0);
    await tickAt(33); // carousel
    expect(carousels()[0]!.params).toMatchObject({ children: "1001,1002" });
    await tickAt(64); // parent
    await tickAt(65); // quota
    expect(await tickAt(66)).toMatchObject({ done: 1 });
    expect(await row()).toMatchObject({ status: "published", externalId: "th_vv" });
  });
});

describe("Threads image-only carousel is unchanged", () => {
  it("makes no item reads and reads the parent at 60 s with the 5-minute cap", async () => {
    scriptThreads(graph).create(["1001", "1002", "1003"]).status("1003", ["IN_PROGRESS"]);
    const { row } = await threadsSetup(storage, { text: "imgs", imageCount: 2 });
    await tickAt(0);
    await tickAt(1);
    await tickAt(2); // carousel created at T0+2 s
    expect(carousels()).toHaveLength(1);
    expect(readsOf("1001")).toHaveLength(0);
    expect(readsOf("1002")).toHaveLength(0);
    expect((await row()).nextAttemptAt!.getTime() - (T0 + 2_000)).toBe(30_000);
    expect(await tickAt(33)).toMatchObject({ continued: 1 });
    expect((await row()).nextAttemptAt!.getTime() - (T0 + 33_000)).toBe(60_000);
    expect(await tickAt(303)).toMatchObject({ failed: 1 }); // 301 s old: past the 5-minute cap
    expect((await row()).lastError).toBe("Threads did not finish processing the post.");
    expect(readsOf("1001")).toHaveLength(0);
  });
});
