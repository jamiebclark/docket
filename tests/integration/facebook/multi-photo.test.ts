// U1 (attached_media on /feed) is verified with mocks only: the fake Graph accepts whatever the
// provider sends, so this proves the request shape, not Meta's behaviour.
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { setStorageForTests } from "../../../src/server/storage";
import { closeDb } from "../../helpers/db";
import { facebookSetup, PAGE_ID } from "../../helpers/facebook-publish";
import { createFakeGraph, type FakeGraph } from "../../helpers/fake-graph";
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

function scriptUploads() {
  let n = 0;
  graph.on("POST", `/v26.0/${PAGE_ID}/photos`, () => ({ kind: "ok", body: { id: `ph${++n}` } }));
}

describe("Facebook multi-photo publishing", () => {
  it("publishes three photos within 4 ticks, ids in order in attached_media", async () => {
    scriptUploads();
    graph.on("POST", `/v26.0/${PAGE_ID}/feed`, { kind: "ok", body: { id: `${PAGE_ID}_9` } });
    const { tick, row } = await facebookSetup(storage, "trip", 3);
    for (let i = 0; i < 3; i++) {
      expect(await tick()).toMatchObject({ claimed: 1, done: 0 });
      expect((await row()).status).not.toBe("published");
    }
    expect(graph.requests.filter((r) => r.path.endsWith("/feed"))).toHaveLength(0);
    expect(await tick()).toMatchObject({ claimed: 1, done: 1 });
    const feed = graph.requests.filter((r) => r.path.endsWith("/feed"));
    expect(feed).toHaveLength(1);
    expect(JSON.parse(feed[0]!.params.attached_media!)).toEqual([{ media_fbid: "ph1" }, { media_fbid: "ph2" }, { media_fbid: "ph3" }]);
    expect(graph.requests.slice(0, 3).every((r) => r.params.published === "false")).toBe(true);
    expect(await row()).toMatchObject({ status: "published", externalId: `${PAGE_ID}_9` });
  });

  it("a rejected later upload leaves nothing public and fails the target", async () => {
    let n = 0;
    graph.on("POST", `/v26.0/${PAGE_ID}/photos`, () =>
      ++n < 2 ? { kind: "ok", body: { id: "ph1" } } : { kind: "graph_error", code: 100, message: "Cannot fetch image" },
    );
    const { tick, row } = await facebookSetup(storage, "trip", 3);
    await tick();
    expect(await tick()).toMatchObject({ failed: 1 });
    expect(graph.requests.filter((r) => r.path.endsWith("/feed"))).toHaveLength(0);
    expect(await row()).toMatchObject({ status: "failed" });
  });

  it("an ambiguous final publish is not retried", async () => {
    scriptUploads();
    graph.on("POST", `/v26.0/${PAGE_ID}/feed`, { kind: "reset_mid_body" });
    const { tick, row } = await facebookSetup(storage, "trip", 2);
    await tick();
    await tick();
    expect(await tick()).toMatchObject({ ambiguous: 1 });
    expect(graph.requests.filter((r) => r.path.endsWith("/feed"))).toHaveLength(1);
    expect((await row()).status).not.toBe("published");
  });
});
