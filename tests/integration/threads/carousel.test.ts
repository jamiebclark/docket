import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { mediaAssets } from "../../../src/server/db/schema/media";
import { createSchedulingRepos } from "../../../src/server/dal/scope";
import { runTick } from "../../../src/server/scheduler";
import { setStorageForTests } from "../../../src/server/storage";
import { atTime } from "../../helpers/clock";
import { closeDb, testDb } from "../../helpers/db";
import { createFakeGraph, type FakeGraph } from "../../helpers/fake-graph";
import { parkAllDueTargets } from "../../helpers/scheduling";
import { createMemoryStorage, type MemoryStorage } from "../../helpers/storage";
import { scriptThreads, THREADS_USER_ID, threadsSetup, V } from "../../helpers/threads-publish";

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
/** Ticks with the engine clock pinned `seconds` after T0 (no sleeping). */
const tickAt = (seconds: number) => atTime(new Date(T0 + seconds * 1000), async () => (await runTick({ config: {} })).publishing.counts);
const U = THREADS_USER_ID;

const creates = () => graph.requests.filter((r) => r.method === "POST" && r.path.endsWith(`/${U}/threads`));
/** Container ids: `item<k>` for carousel items, `car1` for the carousel, `c1` otherwise. */
const scriptCreates = () => {
  let item = 0;
  graph.on("POST", `${V}/${U}/threads`, (req) => ({
    kind: "ok",
    body: { id: req.params.media_type === "CAROUSEL" ? "3001" : req.params.is_carousel_item === "true" ? String(2000 + ++item) : "1001" },
  }));
};

describe("Threads carousels through the real scheduler", () => {
  it.each([2, 5, 20])("publishes %i images in N + 4 ticks with ordered children and one publish", async (n) => {
    scriptCreates();
    scriptThreads(graph).status("3001", ["FINISHED"]).quota(1).publish("th_car");
    const { row } = await threadsSetup(storage, { text: "trip", imageCount: n });

    let s = 0;
    for (let i = 0; i < n; i++) expect(await tickAt(s++)).toMatchObject({ claimed: 1, continued: 1 }); // items
    expect(await tickAt(s++)).toMatchObject({ claimed: 1, continued: 1 }); // carousel
    expect(await tickAt(s + 30)).toMatchObject({ claimed: 1, continued: 1 }); // check_status
    expect(await tickAt(s + 31)).toMatchObject({ claimed: 1, continued: 1 }); // check_quota
    expect(await tickAt(s + 32)).toMatchObject({ claimed: 1, done: 1 }); // publish

    const all = creates();
    expect(all).toHaveLength(n + 1);
    const items = all.slice(0, n);
    expect(items.every((r) => r.params.media_type === "IMAGE" && r.params.is_carousel_item === "true" && !("text" in r.params))).toBe(true);
    expect(new Set(items.map((r) => r.params.image_url)).size).toBe(n);
    expect(all[n]!.params).toMatchObject({
      media_type: "CAROUSEL",
      children: Array.from({ length: n }, (_, i) => String(2001 + i)).join(","),
      text: "trip",
    });
    expect(graph.requests.filter((r) => r.path.endsWith("/threads_publish"))).toHaveLength(1);
    expect(await row()).toMatchObject({ status: "published", externalId: "th_car" });
  });

  it("sends each item's alt text and no text for an image-only post", async () => {
    scriptCreates();
    scriptThreads(graph).status("3001", ["FINISHED"]).quota(1).publish("th_alt");
    const { projectId, postId } = await threadsSetup(storage, { text: "", imageCount: 2 });
    const repos = createSchedulingRepos(testDb(), projectId);
    const ids = await repos.posts.listMediaIds(postId);
    await testDb().update(mediaAssets).set({ altText: "first alt" }).where(and(eq(mediaAssets.projectId, projectId), eq(mediaAssets.id, ids[0]!)));
    for (let s = 0; s < 3; s++) await tickAt(s);
    const all = creates();
    expect(all[0]!.params).toMatchObject({ alt_text: "first alt" });
    expect(all[1]!.params).not.toHaveProperty("alt_text");
    expect(all[2]!.params).toMatchObject({ media_type: "CAROUSEL", children: "2001,2002" });
    expect(all[2]!.params).not.toHaveProperty("text");
  });

  it("uses the Threads variant URL when the original is wider than Threads accepts", async () => {
    scriptThreads(graph).create(["1001"]).status("1001", ["FINISHED"]).quota(1).publish("th_v");
    const { row } = await threadsSetup(storage, { text: "wide", imageCount: 1, imageWidth: 2400 });
    await tickAt(0);
    const url = creates()[0]!.params.image_url!;
    expect(url).toMatch(/\/v\/[^/]+\.jpg$/); // projects/<p>/media/<id>/v/<hash>.jpg
    expect(url).not.toMatch(/original/);
    expect((await row()).status).not.toBe("failed");
  });

  it("restarts at the first create step when an edit changes the image count between steps", async () => {
    scriptCreates();
    scriptThreads(graph).status("3001", ["FINISHED"]).quota(1).publish("th_edit");
    const setup = await threadsSetup(storage, { text: "edit", imageCount: 3 });
    await tickAt(0); // item1
    await tickAt(1); // item2
    // Remove the last image: the saved state (2 items for a 3-image carousel) no longer fits a 2-image post.
    const repos = createSchedulingRepos(testDb(), setup.projectId);
    const detail = await repos.posts.listMediaIds(setup.postId);
    await repos.posts.setMedia(setup.postId, detail.slice(0, 1));
    const before = creates().length;
    await tickAt(2);
    const next = creates().slice(before);
    expect(next).toHaveLength(1);
    expect(next[0]!.params).toMatchObject({ media_type: "IMAGE" });
    expect(next[0]!.params).not.toHaveProperty("is_carousel_item");
    expect(graph.requests.some((r) => r.path.endsWith("/threads_publish"))).toBe(false);
  });
});
