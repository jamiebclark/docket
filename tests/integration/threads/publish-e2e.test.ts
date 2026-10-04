import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { runTick } from "../../../src/server/scheduler";
import { setStorageForTests } from "../../../src/server/storage";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
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
const shape = () => graph.requests.map((r) => `${r.method} ${r.path.replace(/^\/v[\d.]+/, "")}`);
const U = THREADS_USER_ID;

describe("Threads text and image posts through the real scheduler", () => {
  it("publishes a text post in 4 ticks with the exact request sequence", async () => {
    scriptThreads(graph).create(["1001"]).status("1001", ["FINISHED"]).quota(3).publish("th_1");
    const { row } = await threadsSetup(storage, { text: "hello threads" });

    expect(await tickAt(0)).toMatchObject({ claimed: 1, continued: 1 });
    const afterCreate = await row();
    expect(afterCreate.status).not.toBe("published");
    expect(afterCreate.nextAttemptAt!.getTime() - T0).toBe(30_000);
    expect(await tickAt(5)).toMatchObject({ claimed: 0 }); // held back until 30 s
    expect(graph.requests).toHaveLength(1);

    expect(await tickAt(31)).toMatchObject({ claimed: 1, continued: 1 }); // check_status
        expect(await tickAt(32)).toMatchObject({ claimed: 1, continued: 1 }); // check_quota
    expect(await tickAt(33)).toMatchObject({ claimed: 1, done: 1 }); // publish

    expect(shape()).toEqual([`POST /${U}/threads`, "GET /1001", `GET /${U}/threads_publishing_limit`, `POST /${U}/threads_publish`]);
    expect(graph.requests[0]!.params).toMatchObject({ media_type: "TEXT", text: "hello threads" });
    expect(graph.requests[0]!.params).not.toHaveProperty("auto_publish_text");
    expect(graph.requests[1]!.params).toMatchObject({ fields: "status,error_message" });
    expect(graph.requests[3]!.params).toMatchObject({ creation_id: "1001" });
    expect(await row()).toMatchObject({ status: "published", externalId: "th_1" });
  });

  it("publishes one image through IN_PROGRESS then FINISHED in 5 ticks, the second wait about 60 s", async () => {
    scriptThreads(graph).create(["1001"]).status("1001", ["IN_PROGRESS", "FINISHED"]).quota(3).publish("th_2");
    const { row } = await threadsSetup(storage, { text: "pic", imageCount: 1 });

    await tickAt(0);
    await tickAt(31); // IN_PROGRESS
    const waiting = await row();
    expect(waiting.nextAttemptAt!.getTime() - (T0 + 31_000)).toBe(60_000);
    expect(await tickAt(60)).toMatchObject({ claimed: 0 });
    expect(await tickAt(92)).toMatchObject({ claimed: 1, continued: 1 }); // FINISHED
    expect(await tickAt(93)).toMatchObject({ claimed: 1, continued: 1 }); // quota
    expect(await tickAt(94)).toMatchObject({ claimed: 1, done: 1 });

    expect(graph.requests[0]!.params).toMatchObject({ media_type: "IMAGE", text: "pic" });
    expect(graph.requests[0]!.params.image_url).toMatch(/^https:\/\/media\.example\.test\//);
    expect(graph.requests.filter((r) => r.path.endsWith("/1001"))).toHaveLength(2);
    expect(graph.requests.filter((r) => r.path.endsWith("/threads_publish"))).toHaveLength(1);
    expect(await row()).toMatchObject({ status: "published", externalId: "th_2" });
  });

  it("makes at most one platform request per tick and only the publish step may publish", async () => {
    scriptThreads(graph).create(["1001"]).status("1001", ["FINISHED"]).quota(3).publish("th_3");
    const { row } = await threadsSetup(storage, { text: "one each" });
    const seen: number[] = [];
    for (const s of [0, 31, 32, 33]) {
      const before = graph.requests.length;
      await tickAt(s);
      seen.push(graph.requests.length - before);
    }
    expect(seen).toEqual([1, 1, 1, 1]);
    const attempts = (await row()).status;
    expect(attempts).toBe("published");
    expect(graph.requests.filter((r) => r.path.endsWith("/threads_publish"))).toHaveLength(1);
  });

  it("waits an hour when the publishing limit is reached, without publishing", async () => {
    scriptThreads(graph).create(["1001"]).status("1001", ["FINISHED"]).quota(250, 250);
    const { row } = await threadsSetup(storage, { text: "full" });
    await tickAt(0);
    await tickAt(31);
    expect(await tickAt(32)).toMatchObject({ claimed: 1, retried: 1 });
    expect(graph.requests.some((r) => r.path.endsWith("/threads_publish"))).toBe(false);
    expect((await row()).nextAttemptAt!.getTime() - (T0 + 32_000)).toBeGreaterThanOrEqual(3_600_000);
  });

  it("proceeds to publish when the quota cannot be read", async () => {
    scriptThreads(graph).create(["1001"]).status("1001", ["FINISHED"]).publish("th_4");
    graph.on("GET", `${V}/${U}/threads_publishing_limit`, { kind: "ok", body: { data: [] } });
    const { row } = await threadsSetup(storage, { text: "unknown quota" });
    await tickAt(0);
    await tickAt(31);
    await tickAt(32);
    expect(await tickAt(33)).toMatchObject({ claimed: 1, done: 1 });
    expect((await row()).status).toBe("published");
  });
});
