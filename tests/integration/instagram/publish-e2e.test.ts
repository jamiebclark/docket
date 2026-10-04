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
const quota = `/v26.0/${IG_ID}/content_publishing_limit`;
const publish = `/v26.0/${IG_ID}/media_publish`;
const T0 = Date.now() + 60_000;
/** Ticks with the engine clock pinned `seconds` after T0 (no sleeping). */
const tickAt = (seconds: number) => atTime(new Date(T0 + seconds * 1000), async () => (await runTick({ config: {} })).publishing.counts);

describe("Instagram single image through the real scheduler", () => {
  it("publishes in 4 ticks when the container is ready at the first check", async () => {
    graph.on("POST", media, { kind: "ok", body: { id: "c1" } });
    graph.on("GET", "/v26.0/c1", { kind: "ok", body: { status_code: "FINISHED" } });
    graph.on("GET", quota, { kind: "ok", body: { data: [{ quota_usage: 3, config: { quota_total: 100 } }] } });
    graph.on("POST", publish, { kind: "ok", body: { id: "ig_m1" } });
    const { row } = await instagramSetup(storage, "hello", 1);

    expect(await tickAt(0)).toMatchObject({ claimed: 1, continued: 1 });
    const afterCreate = await row();
    expect(afterCreate.status).not.toBe("published");
    // The status check is held back by the engine until the 10 s delay passes.
    expect(afterCreate.nextAttemptAt!.getTime() - T0).toBe(10_000);
    expect(await tickAt(5)).toMatchObject({ claimed: 0 });
    expect(graph.requests).toHaveLength(1);

    expect(await tickAt(11)).toMatchObject({ claimed: 1, continued: 1 }); // check_status
    expect(await tickAt(12)).toMatchObject({ claimed: 1, continued: 1 }); // check_quota
    expect(await tickAt(13)).toMatchObject({ claimed: 1, done: 1 }); // publish

    expect(graph.requests.map((r) => `${r.method} ${r.path.replace(/^\/v[\d.]+/, "")}`)).toEqual([
      `POST /${IG_ID}/media`,
      "GET /c1",
      `GET /${IG_ID}/content_publishing_limit`,
      `POST /${IG_ID}/media_publish`,
    ]);
    expect(graph.requests[0]!.params).toMatchObject({ caption: "hello" });
    expect(graph.requests[0]!.params.image_url).toMatch(/^https:\/\/media\.example\.test\//);
    expect(await row()).toMatchObject({ status: "published", externalId: "ig_m1" });
  });

  it("takes the extra tick for IN_PROGRESS then FINISHED, each check carrying a notBefore", async () => {
    graph.on("POST", media, { kind: "ok", body: { id: "c1" } });
    graph.on("GET", "/v26.0/c1", [
      { kind: "ok", body: { status_code: "IN_PROGRESS" } },
      { kind: "ok", body: { status_code: "FINISHED" } },
    ]);
    graph.on("GET", quota, { kind: "ok", body: { data: [{ quota_usage: 3, config: { quota_total: 100 } }] } });
    graph.on("POST", publish, { kind: "ok", body: { id: "ig_m2" } });
    const { row } = await instagramSetup(storage, "slow", 1);

    await tickAt(0);
    await tickAt(11); // IN_PROGRESS
    const waiting = await row();
    expect(waiting.nextAttemptAt!.getTime() - (T0 + 11_000)).toBe(10_000);
    expect(await tickAt(15)).toMatchObject({ claimed: 0 }); // not yet due
    expect(await tickAt(22)).toMatchObject({ claimed: 1, continued: 1 }); // FINISHED
    expect(await tickAt(23)).toMatchObject({ claimed: 1, continued: 1 }); // quota
    expect(await tickAt(24)).toMatchObject({ claimed: 1, done: 1 });

    expect(graph.requests.filter((r) => r.path.endsWith("/c1"))).toHaveLength(2);
    expect(graph.requests.filter((r) => r.path.endsWith("/media_publish"))).toHaveLength(1);
    expect(await row()).toMatchObject({ status: "published", externalId: "ig_m2" });
  });

  it("checks the quota before publishing and waits an hour when it is full", async () => {
    graph.on("POST", media, { kind: "ok", body: { id: "c1" } });
    graph.on("GET", "/v26.0/c1", { kind: "ok", body: { status_code: "FINISHED" } });
    graph.on("GET", quota, { kind: "ok", body: { data: [{ quota_usage: 100, config: { quota_total: 100 } }] } });
    const { row } = await instagramSetup(storage, "full", 1);

    await tickAt(0);
    await tickAt(11);
    expect(await tickAt(12)).toMatchObject({ claimed: 1, retried: 1 });
    expect(graph.requests.some((r) => r.path.endsWith("/media_publish"))).toBe(false);
    expect((await row()).nextAttemptAt!.getTime() - (T0 + 12_000)).toBeGreaterThanOrEqual(3_600_000);
  });
});
