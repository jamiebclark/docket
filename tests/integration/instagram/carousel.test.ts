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
const okQuota = { kind: "ok", body: { data: [{ quota_usage: 1, config: { quota_total: 100 } }] } } as const;

describe("Instagram carousel through the real scheduler", () => {
  it.each([2, 4])("publishes %i images in N + 4 ticks with one carousel container and one publish", async (n) => {
    let item = 0;
    graph.on("POST", media, (req) => ({ kind: "ok", body: { id: req.params.media_type === "CAROUSEL" ? "car1" : `item${++item}` } }));
    graph.on("GET", "/v26.0/car1", { kind: "ok", body: { status_code: "FINISHED" } });
    graph.on("GET", quota, okQuota);
    graph.on("POST", publish, { kind: "ok", body: { id: "ig_car" } });
    const { row } = await instagramSetup(storage, "trip", n);

    let s = 0;
    for (let i = 0; i < n; i++) expect(await tickAt(s++)).toMatchObject({ claimed: 1, continued: 1 }); // items
    expect(await tickAt(s++)).toMatchObject({ claimed: 1, continued: 1 }); // carousel container
    expect(await tickAt(s + 10)).toMatchObject({ claimed: 1, continued: 1 }); // check_status
    expect(await tickAt(s + 11)).toMatchObject({ claimed: 1, continued: 1 }); // check_quota
    expect(await tickAt(s + 12)).toMatchObject({ claimed: 1, done: 1 }); // publish

    const creates = graph.requests.filter((r) => r.method === "POST" && r.path.endsWith("/media"));
    expect(creates).toHaveLength(n + 1);
    const items = creates.slice(0, n);
    expect(items.every((r) => r.params.is_carousel_item === "true" && !("caption" in r.params))).toBe(true);
    expect(new Set(items.map((r) => r.params.image_url)).size).toBe(n);
    const carousels = creates.filter((r) => r.params.media_type === "CAROUSEL");
    expect(carousels).toHaveLength(1);
    expect(carousels[0]!.params).toMatchObject({
      children: Array.from({ length: n }, (_, i) => `item${i + 1}`).join(","),
      caption: "trip",
    });
    expect(graph.requests.filter((r) => r.path.endsWith("/media_publish"))).toHaveLength(1);
    expect(await row()).toMatchObject({ status: "published", externalId: "ig_car" });
  });
});
