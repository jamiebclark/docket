import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { postTargets } from "../../../src/server/db/schema/posts";
import { createSchedulingRepos } from "../../../src/server/dal/scope";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { runTick } from "../../../src/server/scheduler";
import { setStorageForTests } from "../../../src/server/storage";
import { atTime } from "../../helpers/clock";
import { closeDb, testDb } from "../../helpers/db";
import { jpeg } from "../../helpers/images";
import { createFakeGraph, type FakeGraph } from "../../helpers/fake-graph";
import { createImageAssets } from "../../helpers/factories";
import { parkAllDueTargets } from "../../helpers/scheduling";
import { createMemoryStorage, type MemoryStorage } from "../../helpers/storage";
import { scriptThreads, THREADS_USER_ID, threadsVideoSetup, V } from "../../helpers/threads-publish";

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
const tickAtMs = (ms: number) =>
  atTime(new Date(ms), async () => (await runTick({ config: { providerTimeoutMs: 100 } })).publishing.counts);
const tickAt = (seconds: number) => tickAtMs(T0 + seconds * 1000);
const U = THREADS_USER_ID;
const create = `${V}/${U}/threads`;
const publish = `${V}/${U}/threads_publish`;
const creates = () => graph.requests.filter((r) => r.method === "POST" && r.path === create);
const carousels = () => creates().filter((r) => r.params.media_type === "CAROUSEL");
const publishes = () => graph.requests.filter((r) => r.path === publish);
const readsOf = (id: string) => graph.requests.filter((r) => r.method === "GET" && r.path === `${V}/${id}`);

type Row = { status: string; nextAttemptAt: Date | null; lastError: string | null };
/** Ticks at each due time (at least a second after the last) until the target leaves the queue, at most `max` ticks. */
async function drive(row: () => Promise<Row>, from: number, max = 60) {
  let at = from;
  for (let i = 0; i < max; i++) {
    const next = (await row()).nextAttemptAt;
    at = Math.max(next ? next.getTime() : 0, at + 1000);
    await tickAtMs(at);
    const s = (await row()).status;
    if (s === "failed" || s === "ambiguous" || s === "published") return at;
  }
  throw new Error("target never settled");
}

/** Image rows whose objects exist in storage, as the engine requires. */
async function storedImages(projectId: string, count: number) {
  const assets = await createImageAssets(projectId, count);
  for (const a of assets) await storage.put(a.storageKey, await jpeg(400, 300), "image/jpeg");
  return assets;
}

const SUFFIX = "Nothing was published; retry the post after fixing the video.";
const CODES: [string, string][] = [
  ["FAILED_DOWNLOADING_VIDEO", "publicly readable"],
  ["FAILED_PROCESSING_VIDEO", "usually because of its encoding."],
  ["INVALID_DURATION", "Threads videos can be at most 300 seconds."],
  ["INVALID_FRAME_RATE", "Threads videos must be 23 to 60 frames per second."],
  ["INVALID_BIT_RATE", "bitrate is above Threads' limit"],
  ["INVALID_ASPEC_RATIO", "aspect ratio between 1:100 and 10:1."],
];

describe("Threads video processing errors", () => {
  describe.each(CODES)("%s", (code, fragment) => {
    it("fails a single video with the explanation, and publishes nothing", async () => {
      scriptThreads(graph).create(["1001"]).status("1001", [{ status: "ERROR", error_message: `${code}.` }]);
      const { row } = await threadsVideoSetup(storage, "clip");
      await tickAt(0);
      expect(await tickAt(31)).toMatchObject({ failed: 1 });
      const r = await row();
      expect(r).toMatchObject({ status: "failed", nextAttemptAt: null });
      expect(r.lastError!.startsWith(`Threads could not process the video: ${code}. `)).toBe(true);
      expect(r.lastError).toContain(fragment);
      expect(r.lastError!.endsWith(SUFFIX)).toBe(true);
      expect(publishes()).toHaveLength(0);
    });

    it("fails item 2 of a carousel with no CAROUSEL or publish request", async () => {
      scriptThreads(graph).create(["1001", "1002"]).status("1002", [{ status: "ERROR", error_message: code }]);
      const { row } = await threadsVideoSetup(storage, "clip", ["image", "video"]);
      await tickAt(0);
      await tickAt(1);
      expect(await tickAt(32)).toMatchObject({ failed: 1 });
      const r = await row();
      expect(r.status).toBe("failed");
      expect(r.lastError!.startsWith(`Threads could not process the video in item 2 of the carousel: ${code}. `)).toBe(true);
      expect(r.lastError).toContain(fragment);
      expect(r.lastError!.endsWith(SUFFIX)).toBe(true);
      expect(carousels()).toHaveLength(0);
      expect(publishes()).toHaveLength(0);
    });
  });

  it("shows an unknown message as sent, and a missing one as (status ERROR)", async () => {
    scriptThreads(graph).create(["1001"]).status("1001", [{ status: "ERROR", error_message: "Something odd happened." }]);
    const one = await threadsVideoSetup(storage, "x");
    await tickAt(0);
    await tickAt(31);
    expect((await one.row()).lastError).toBe(`Threads could not process the video: Something odd happened. ${SUFFIX}`);

    graph.reset();
    scriptThreads(graph).create(["2001"]).status("2001", ["ERROR"]);
    const two = await threadsVideoSetup(storage, "y");
    await tickAt(0);
    await tickAt(31);
    expect((await two.row()).lastError).toBe(`Threads could not process the video (status ERROR). ${SUFFIX}`);
  });
});

describe("Threads video processing ceiling", () => {
  const CEILING = "Threads did not finish processing the video within 60 minutes; nothing was published. Retry the post to try again.";

  it("a single video moves to the 5-minute pace after 5 minutes and fails at 60 minutes within 17 reads", async () => {
    scriptThreads(graph).create(["1001"]).status("1001", ["IN_PROGRESS"]);
    const { row } = await threadsVideoSetup(storage, "slow");
    await tickAt(0);
    const gaps: number[] = [];
    let last = (await row()).nextAttemptAt!.getTime();
    const end = await drive(async () => {
      const r = await row();
      if (r.nextAttemptAt && r.nextAttemptAt.getTime() !== last) {
        gaps.push(r.nextAttemptAt.getTime() - last);
        last = r.nextAttemptAt.getTime();
      }
      return r;
    }, T0);
    expect(readsOf("1001").length).toBeLessThanOrEqual(17);
    expect(gaps.slice(0, 4).every((g) => g === 60_000)).toBe(true);
    expect(gaps.at(-1)).toBe(300_000);
    expect(end - T0).toBeGreaterThanOrEqual(3_600_000);
    expect((await row()).lastError).toBe(CEILING);
    expect(publishes()).toHaveLength(0);
  });

  it("a video item does the same, and the carousel is never created", async () => {
    scriptThreads(graph).create(["1001", "1002"]).status("1002", ["IN_PROGRESS"]);
    const { row } = await threadsVideoSetup(storage, "slow", ["image", "video"]);
    await tickAt(0);
    await tickAt(1);
    const end = await drive(row, T0 + 1000);
    expect(readsOf("1002").length).toBeLessThanOrEqual(17);
    expect(end - (T0 + 1000)).toBeGreaterThanOrEqual(3_600_000);
    expect((await row()).lastError).toBe(CEILING);
    expect(readsOf("1001")).toHaveLength(0);
    expect(carousels()).toHaveLength(0);
    expect(publishes()).toHaveLength(0);
  });
});

describe("Threads video EXPIRED", () => {
  it("recreates a single video from the create step and fails on the third expiry", async () => {
    scriptThreads(graph).create(["1001", "1002", "1003"]).status("1001", ["EXPIRED"]).status("1002", ["EXPIRED"]).status("1003", ["EXPIRED"]);
    const { row } = await threadsVideoSetup(storage, "exp");
    await drive(row, T0 - 1000);
    expect(creates()).toHaveLength(3);
    expect(creates().every((r) => r.params.media_type === "VIDEO")).toBe(true);
    expect(await row()).toMatchObject({ status: "failed" });
    expect((await row()).lastError).toContain("tried 3 times");
    expect(publishes()).toHaveLength(0);
  });

  it("recreates the whole carousel from item 1 when a video item expires, and fails on the third expiry", async () => {
    scriptThreads(graph)
      .create(["1001", "1002", "1003", "1004", "1005", "1006"])
      .status("1002", ["EXPIRED"])
      .status("1004", ["EXPIRED"])
      .status("1006", ["EXPIRED"]);
    const { row } = await threadsVideoSetup(storage, "exp", ["image", "video"]);
    await drive(row, T0 - 1000);
    expect(creates().map((r) => r.params.media_type)).toEqual(["IMAGE", "VIDEO", "IMAGE", "VIDEO", "IMAGE", "VIDEO"]);
    expect(carousels()).toHaveLength(0);
    expect((await row()).status).toBe("failed");
    expect((await row()).lastError).toContain("tried 3 times");
  });
});

describe("Threads video item statuses", () => {
  it("PUBLISHED while checking an item is ambiguous and nothing is published", async () => {
    scriptThreads(graph).create(["1001", "1002"]).status("1002", ["PUBLISHED"]);
    const { row } = await threadsVideoSetup(storage, "pub", ["image", "video"]);
    await tickAt(0);
    await tickAt(1);
    expect(await tickAt(32)).toMatchObject({ ambiguous: 1 });
    expect(await row()).toMatchObject({ status: "ambiguous", nextAttemptAt: null });
    expect(publishes()).toHaveLength(0);
    expect(await tickAt(600)).toMatchObject({ claimed: 0 });
  });

  it("an unknown status is retried, on an item and on a single video", async () => {
    scriptThreads(graph).create(["1001", "1002"]).status("1002", ["MYSTERY", "FINISHED"]);
    const { row } = await threadsVideoSetup(storage, "unk", ["image", "video"]);
    await tickAt(0);
    await tickAt(1);
    expect(await tickAt(32)).toMatchObject({ retried: 1 });
    expect((await row()).status).not.toBe("failed");
    expect((await row()).nextAttemptAt).not.toBeNull();

    graph.reset();
    scriptThreads(graph).create(["2001"]).status("2001", [{ status: "NOPE" }, "FINISHED"]);
    const single = await threadsVideoSetup(storage, "unk");
    await tickAt(0);
    expect(await tickAt(31)).toMatchObject({ retried: 1 });
    expect((await single.row()).status).not.toBe("failed");
  });
});

describe("Threads video token rejection", () => {
  it("a 190 on a video item read fails the target and flags the account", async () => {
    scriptThreads(graph).create(["1001", "1002"]);
    graph.on("GET", `${V}/1002`, { kind: "graph_error", code: 190, message: "Invalid OAuth access token", status: 401 });
    const { projectId, accountId, row } = await threadsVideoSetup(storage, "tok", ["image", "video"]);
    await tickAt(0);
    await tickAt(1);
    expect(await tickAt(32)).toMatchObject({ failed: 1 });
    expect(await row()).toMatchObject({ status: "failed", nextAttemptAt: null });
    expect(await forSchedulerProject(projectId).accounts.get(accountId)).toMatchObject({ status: "needs_reauth" });
    expect(carousels()).toHaveLength(0);
  });
});

describe("Threads video resume", () => {
  it("a worker killed mid-step resumes at the saved step without creating anything again", async () => {
    scriptThreads(graph).create(["1001", "1002"]).status("1002", ["FINISHED"]);
    const { projectId, targetId, row } = await threadsVideoSetup(storage, "kill", ["image", "video"]);
    await tickAt(0);
    await tickAt(1);
    expect(creates()).toHaveLength(2);
    const past = new Date(Date.now() - 60_000);
    await testDb()
      .update(postTargets)
      .set({ status: "publishing", leaseOwner: randomUUID(), leaseUntil: past, inFlightStep: "check_item_2", inFlightMayPublish: false, firstStepAt: past })
      .where(and(eq(postTargets.projectId, projectId), eq(postTargets.id, targetId)));
    expect(await tickAt(32)).toMatchObject({ recovered: 1, ambiguous: 0 });
    expect(["failed", "ambiguous"]).not.toContain((await row()).status);
    await tickAt(33);
    await tickAt(34);
    expect(readsOf("1002").length).toBeGreaterThanOrEqual(1);
    expect(creates().filter((r) => r.params.media_type !== "CAROUSEL")).toHaveLength(2);
    expect(carousels()).toHaveLength(1);
  });
});

describe("Threads video post changed between ticks", () => {
  it("a single video swapped for an image restarts at create_container", async () => {
    scriptThreads(graph).create(["1001", "1002"]).status("1001", ["FINISHED"]);
    const { projectId, postId, row } = await threadsVideoSetup(storage, "swap");
    await tickAt(0);
    const [image] = await storedImages(projectId, 1);
    await createSchedulingRepos(testDb(), projectId).posts.setMedia(postId, [image!.id]);
    await tickAt(31);
    expect(creates()).toHaveLength(2);
    expect(creates()[1]!.params).toMatchObject({ media_type: "IMAGE" });
    expect(readsOf("1001")).toHaveLength(0);
    expect((await row()).status).not.toBe("failed");
  });

  it("a video item swapped for an image restarts at create_item_1", async () => {
    scriptThreads(graph).create(["1001", "1002", "1003"]).status("1002", ["FINISHED"]);
    const { projectId, postId, row } = await threadsVideoSetup(storage, "swap", ["image", "video"]);
    await tickAt(0);
    await tickAt(1);
    const images = await storedImages(projectId, 2);
    await createSchedulingRepos(testDb(), projectId).posts.setMedia(postId, images.map((i) => i.id));
    await tickAt(32);
    expect(creates()).toHaveLength(3);
    expect(creates()[2]!.params).toMatchObject({ media_type: "IMAGE", is_carousel_item: "true" });
    expect(readsOf("1002")).toHaveLength(0);
    expect((await row()).status).not.toBe("failed");
  });
});

describe("Threads 23-hour guard", () => {
  it("is measured from the oldest item, so a carousel whose item aged out is recreated before the quota read", async () => {
    scriptThreads(graph)
      .create(["1001", "1002", "1003", "1004", "1005"])
      .status("1002", ["FINISHED"])
      .status("1003", ["FINISHED"])
      .quota(3)
      .publish("th_never");
    const { row } = await threadsVideoSetup(storage, "aged", ["image", "video"]);
    await tickAt(0); // item 1 at T0
    await tickAt(1); // item 2 at T0+1 s
    const day = 23 * 3_600;
    await tickAt(day + 1); // item 2 FINISHED, 23 h late
    await tickAt(day + 2); // carousel created now
    await tickAt(day + 33); // parent FINISHED
    expect(carousels()).toHaveLength(1);
    await tickAt(day + 34); // check_quota: the oldest item is past 23 h
    expect(graph.requests.filter((r) => r.path === `${V}/${U}/threads_publishing_limit`)).toHaveLength(0);
    expect(publishes()).toHaveLength(0);
    await tickAt(day + 35); // restarted from item 1
    expect(creates().at(-1)!.params).toMatchObject({ media_type: "IMAGE", is_carousel_item: "true" });
    expect((await row()).status).not.toBe("failed");
  });
});
