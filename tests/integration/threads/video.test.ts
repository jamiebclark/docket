import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { runTick } from "../../../src/server/scheduler";
import { setStorageForTests } from "../../../src/server/storage";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { createFakeGraph, type FakeGraph, type GraphReply } from "../../helpers/fake-graph";
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
const tickAt = (seconds: number) =>
  atTime(new Date(T0 + seconds * 1000), async () => (await runTick({ config: { providerTimeoutMs: 100 } })).publishing.counts);
const U = THREADS_USER_ID;
const create = `${V}/${U}/threads`;
const publish = `${V}/${U}/threads_publish`;
const quota = `${V}/${U}/threads_publishing_limit`;
const creates = () => graph.requests.filter((r) => r.method === "POST" && r.path === create);
const publishes = () => graph.requests.filter((r) => r.path === publish);
const reads = () => graph.requests.filter((r) => r.method === "GET" && r.path === `${V}/1001`);

describe("Threads single video publishing", () => {
  it("creates a VIDEO container, reads at ~30/90/150 s, checks the quota and publishes once", async () => {
    scriptThreads(graph).create(["1001"]).status("1001", ["IN_PROGRESS", "IN_PROGRESS", "IN_PROGRESS", "FINISHED"]).quota(3).publish("th_v1");
    const { row } = await threadsVideoSetup(storage, "a clip");
    await tickAt(0);
    expect(creates()).toHaveLength(1);
    const p = creates()[0]!.params;
    expect(p).toMatchObject({ media_type: "VIDEO", text: "a clip" });
    expect(p.video_url).toMatch(/^http:\/\/localhost:3000\/media\/.+\.mp4$/);
    for (const k of ["image_url", "alt_text", "is_carousel_item", "children"]) expect(p).not.toHaveProperty(k);

    expect((await row()).nextAttemptAt!.getTime() - T0).toBe(30_000);
    expect(await tickAt(29)).toMatchObject({ claimed: 0 });
    for (const [s, gap] of [[31, 60_000], [92, 60_000], [153, 60_000]] as const) {
      expect(await tickAt(s)).toMatchObject({ claimed: 1, continued: 1 });
      expect((await row()).nextAttemptAt!.getTime() - (T0 + s * 1000)).toBe(gap);
    }
    expect(reads()).toHaveLength(3);
    expect(reads()[0]!.params).toMatchObject({ fields: "status,error_message" });
    expect(publishes()).toHaveLength(0);

    expect(await tickAt(214)).toMatchObject({ claimed: 1, continued: 1 }); // FINISHED
    expect(await tickAt(215)).toMatchObject({ claimed: 1, continued: 1 }); // quota
    expect(graph.requests.filter((r) => r.path === quota)).toHaveLength(1);
    expect(await tickAt(216)).toMatchObject({ claimed: 1, done: 1 });
    expect(publishes()).toHaveLength(1);
    expect(publishes()[0]!.params).toMatchObject({ creation_id: "1001" });
    expect(await row()).toMatchObject({ status: "published", externalId: "th_v1" });
  });

  it("sends no text param when the target text is empty", async () => {
    scriptThreads(graph).create(["1001"]);
    await threadsVideoSetup(storage, "");
    await tickAt(0);
    expect(creates()[0]!.params).not.toHaveProperty("text");
  });

  it("retries a timeout on create and on a status read", async () => {
    graph.on("POST", create, [{ kind: "hang" }, { kind: "ok", body: { id: "1001" } }]);
    scriptThreads(graph).status("1001", ["FINISHED"]);
    graph.on("GET", `${V}/1001`, [{ kind: "hang" }, { kind: "ok", body: { status: "FINISHED" } }]);
    const { row } = await threadsVideoSetup(storage, "retry");
    expect(await tickAt(0)).toMatchObject({ retried: 1 });
    expect((await row()).status).not.toBe("failed");
    const next = Math.ceil(((await row()).nextAttemptAt!.getTime() - T0) / 1000) + 1;
    expect(await tickAt(next)).toMatchObject({ continued: 1 }); // created
    const readAt = next + 31;
    expect(await tickAt(readAt)).toMatchObject({ retried: 1 }); // hung read
    expect((await row()).status).not.toBe("failed");
    expect(publishes()).toHaveLength(0);
  });

  describe.each<[string, GraphReply]>([
    ["a timeout after the publish was sent", { kind: "hang" }],
    ["an unreadable publish reply", { kind: "unparseable" }],
  ])("%s", (_label, reply) => {
    it("ends ambiguous and is never retried", async () => {
      scriptThreads(graph).create(["1001"]).status("1001", ["FINISHED"]).quota(3);
      graph.on("POST", publish, reply);
      const { row } = await threadsVideoSetup(storage, "once");
      await tickAt(0);
      await tickAt(31);
      await tickAt(32);
      expect(await tickAt(33)).toMatchObject({ ambiguous: 1 });
      expect(await row()).toMatchObject({ status: "ambiguous", nextAttemptAt: null });
      expect(await tickAt(500)).toMatchObject({ claimed: 0 });
      expect(publishes()).toHaveLength(1);
    });
  });
});
