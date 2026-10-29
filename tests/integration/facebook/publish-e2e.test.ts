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

describe("Facebook publishing through the real scheduler", () => {
  it("publishes text with a URL as one feed request carrying message and link", async () => {
    graph.on("POST", `/v26.0/${PAGE_ID}/feed`, { kind: "ok", body: { id: `${PAGE_ID}_42` } });
    graph.on("GET", `/v26.0/${PAGE_ID}_42`, { kind: "ok", body: { permalink_url: `https://www.facebook.com/${PAGE_ID}/posts/42` } });
    const text = "new post https://example.com/read";
    const { tick, row } = await facebookSetup(storage, text, 0);
    expect(await tick()).toMatchObject({ claimed: 1, done: 1 });
    // One feed write, then one read for the post's own address — the feed reply carries only the id.
    expect(graph.requests.map((r) => `${r.method} ${r.path}`)).toEqual([`POST /v26.0/${PAGE_ID}/feed`, `GET /v26.0/${PAGE_ID}_42`]);
    expect(graph.requests[0]).toMatchObject({ method: "POST", path: `/v26.0/${PAGE_ID}/feed`, hadToken: true });
    expect(graph.requests[0]!.params).toMatchObject({ message: text, link: "https://example.com/read" });
    // The address reaches the row, which is what lets the Posts page and the inbox link out to it.
    expect(await row()).toMatchObject({
      status: "published",
      externalId: `${PAGE_ID}_42`,
      externalUrl: `https://www.facebook.com/${PAGE_ID}/posts/42`,
    });
  });

  it("publishes without an address when the permalink read fails", async () => {
    graph.on("POST", `/v26.0/${PAGE_ID}/feed`, { kind: "ok", body: { id: `${PAGE_ID}_43` } });
    graph.on("GET", `/v26.0/${PAGE_ID}_43`, { kind: "http", status: 500 });
    const { tick, row } = await facebookSetup(storage, "no address", 0);
    expect(await tick()).toMatchObject({ claimed: 1, done: 1 });
    expect(await row()).toMatchObject({ status: "published", externalId: `${PAGE_ID}_43`, externalUrl: null });
  });

  it("publishes one image through the photos endpoint with URL and caption", async () => {
    graph.on("POST", `/v26.0/${PAGE_ID}/photos`, { kind: "ok", body: { id: "777", post_id: `${PAGE_ID}_88` } });
    graph.on("GET", `/v26.0/${PAGE_ID}_88`, { kind: "ok", body: { permalink_url: `https://www.facebook.com/${PAGE_ID}/posts/88` } });
    const { tick, row } = await facebookSetup(storage, "a caption", 1);
    expect(await tick()).toMatchObject({ claimed: 1, done: 1 });
    // The address is read for `post_id`, the id Docket stores, not the photo's own id.
    expect(graph.requests.map((r) => `${r.method} ${r.path}`)).toEqual([`POST /v26.0/${PAGE_ID}/photos`, `GET /v26.0/${PAGE_ID}_88`]);
    const { params } = graph.requests[0]!;
    expect(params.caption).toBe("a caption");
    expect(params.url).toMatch(/^https:\/\/media\.example\.test\//);
    expect(await row()).toMatchObject({
      status: "published",
      externalId: `${PAGE_ID}_88`,
      externalUrl: `https://www.facebook.com/${PAGE_ID}/posts/88`,
    });
  });

  it("never uses Facebook native scheduling", async () => {
    graph.fallback({ kind: "ok", body: { id: "1" } });
    const { tick } = await facebookSetup(storage, "plain", 0);
    await tick();
    for (const r of graph.requests) {
      expect(r.params).not.toHaveProperty("scheduled_publish_time");
      expect(r.params).not.toHaveProperty("published");
    }
  });
});
