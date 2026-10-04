import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { runTick } from "../../../src/server/scheduler";
import { setStorageForTests } from "../../../src/server/storage";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { createFakeGraph, type FakeGraph } from "../../helpers/fake-graph";
import { IG_ID, instagramSetup } from "../../helpers/instagram-publish";
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
const T0 = Date.now() + 60_000;
/** Ticks with the engine clock pinned `seconds` after T0 (no sleeping). */
const tickAt = (seconds: number) => atTime(new Date(T0 + seconds * 1000), async () => (await runTick({ config: {} })).publishing.counts);

const publishRequests = () => graph.requests.filter((r) => r.path.endsWith("/media_publish"));

describe("Instagram container status through the real scheduler", () => {
  it("ERROR is fatal with no publish request", async () => {
    graph.on("POST", media, { kind: "ok", body: { id: "c1" } });
    graph.on("GET", "/v26.0/c1", { kind: "ok", body: { status_code: "ERROR" } });
    const { row } = await instagramSetup(storage, "bad", 1);
    await tickAt(0);
    expect(await tickAt(11)).toMatchObject({ claimed: 1, failed: 1 });
    expect(publishRequests()).toHaveLength(0);
    expect((await row()).status).toBe("failed");
  });

  it("EXPIRED recreates the container, up to twice, then fails", async () => {
    let n = 0;
    graph.on("POST", media, () => ({ kind: "ok", body: { id: `c${++n}` } }));
    for (const id of ["c1", "c2", "c3"]) graph.on("GET", `/v26.0/${id}`, { kind: "ok", body: { status_code: "EXPIRED" } });
    const { row } = await instagramSetup(storage, "again", 1);
    let s = 0;
    for (let round = 0; round < 2; round++) {
      await tickAt(s); // create
      s += 11;
      expect(await tickAt(s)).toMatchObject({ claimed: 1, continued: 1 }); // EXPIRED → recreate
      s += 1;
    }
    await tickAt(s); // third create
    s += 11;
    expect(await tickAt(s)).toMatchObject({ claimed: 1, failed: 1 });
    expect(graph.requests.filter((r) => r.method === "POST" && r.path.endsWith("/media"))).toHaveLength(3);
    expect(publishRequests()).toHaveLength(0);
    const final = await row();
    expect(final.status).toBe("failed");
    expect(final.lastError).toContain("tried 3 times");
  });

  it("PUBLISHED before our publish is ambiguous and nothing is published", async () => {
    graph.on("POST", media, { kind: "ok", body: { id: "c1" } });
    graph.on("GET", "/v26.0/c1", { kind: "ok", body: { status_code: "PUBLISHED" } });
    await instagramSetup(storage, "dup", 1);
    await tickAt(0);
    expect(await tickAt(11)).toMatchObject({ claimed: 1, ambiguous: 1 });
    expect(publishRequests()).toHaveLength(0);
  });

  it("gives up after 60 minutes of IN_PROGRESS", async () => {
    graph.on("POST", media, { kind: "ok", body: { id: "c1" } });
    graph.on("GET", "/v26.0/c1", { kind: "ok", body: { status_code: "IN_PROGRESS" } });
    const { row } = await instagramSetup(storage, "stuck", 1);
    await tickAt(0);
    expect(await tickAt(11)).toMatchObject({ claimed: 1, continued: 1 });
    expect(await tickAt(3 * 60)).toMatchObject({ claimed: 1, continued: 1 });
    expect(await tickAt(61 * 60)).toMatchObject({ claimed: 1, failed: 1 });
    expect(publishRequests()).toHaveLength(0);
    expect((await row()).lastError).toContain("did not finish processing");
  });
});
