import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { docsUrl } from "@/lib/docs";
import { createFakeGraph, type FakeGraph } from "../../../tests/helpers/fake-graph";
import type { MediaItem, PublishContext } from "../types";
import { advanceFacebook } from "./publish";
import { facebookStepFor } from "./steps";

const PAGE = "1234567890";
const TOKEN = "EAAB-page-token-0123456789abcdef";
const now = new Date("2026-01-01T00:00:00Z");
const img = (n: number): MediaItem => ({ url: `https://media.test/${n}.jpg`, mimeType: "image/jpeg", width: 10, height: 10, bytes: 100, altText: "" });

let graph: FakeGraph;
beforeEach(() => {
  graph = createFakeGraph().install();
});
afterEach(() => graph.uninstall());

function ctx(text: string, mediaCount: number, state: unknown = null, stepName?: string): PublishContext {
  const media = Array.from({ length: mediaCount }, (_, i) => img(i + 1));
  const step = stepName ? { name: stepName, mayPublish: !stepName.startsWith("upload_") } : facebookStepFor(state, { text, mediaCount });
  return {
    target: { id: "t1", scheduledAt: now, attempt: 1 },
    account: { id: "a1", externalId: PAGE, displayName: "Page", settings: {}, credentials: { pageToken: TOKEN } },
    content: { text, media },
    postType: mediaCount === 0 ? "text" : mediaCount === 1 ? "image" : "carousel",
    step,
    state,
    now,
    signal: new AbortController().signal,
  };
}

const feed = new RegExp(`/v[\\d.]+/${PAGE}/feed$`);
const photos = new RegExp(`/v[\\d.]+/${PAGE}/photos$`);

function paths() {
  return graph.requests.map((r) => r.path.replace(/^\/v[\d.]+/, ""));
}

describe("Facebook publish success paths", () => {
  it("publishes text only", async () => {
    graph.fallback({ kind: "ok", body: { id: `${PAGE}_99` } });
    const r = await advanceFacebook(ctx("hello", 0));
    expect(r).toMatchObject({ kind: "done", externalId: `${PAGE}_99` });
    expect(graph.requests).toHaveLength(1);
    expect(graph.requests[0]!.path).toMatch(feed);
    expect(graph.requests[0]!.params).toEqual({ message: "hello", access_token: "[redacted]" });
  });

  it("sends the first URL as link", async () => {
    graph.fallback({ kind: "ok", body: { id: "p_1" } });
    await advanceFacebook(ctx("read https://example.com/a. and https://b.test", 0));
    expect(graph.requests[0]!.params).toMatchObject({ message: "read https://example.com/a. and https://b.test", link: "https://example.com/a" });
  });

  it("publishes one photo with a caption, preferring post_id", async () => {
    graph.fallback({ kind: "ok", body: { id: "photo1", post_id: `${PAGE}_55` } });
    const r = await advanceFacebook(ctx("look https://example.com", 1));
    expect(r).toMatchObject({ kind: "done", externalId: `${PAGE}_55` });
    expect(graph.requests[0]!.path).toMatch(photos);
    expect(graph.requests[0]!.params).toEqual({ url: "https://media.test/1.jpg", caption: "look https://example.com", access_token: "[redacted]" });
  });

  it("omits an empty caption", async () => {
    graph.fallback({ kind: "ok", body: { id: "photo1" } });
    const r = await advanceFacebook(ctx("", 1));
    expect(r).toMatchObject({ kind: "done", externalId: "photo1" });
    expect(graph.requests[0]!.params).not.toHaveProperty("caption");
  });

  it("uploads unpublished photos, then publishes with attached_media in order", async () => {
    let n = 0;
    graph.on("POST", `/v26.0/${PAGE}/photos`, () => ({ kind: "ok", body: { id: `ph${++n}` } }));
    graph.on("POST", `/v26.0/${PAGE}/feed`, { kind: "ok", body: { id: `${PAGE}_77` } });
    let state: unknown = null;
    for (let i = 1; i <= 3; i++) {
      const c = ctx("trip", 3, state);
      expect(c.step.name).toBe(`upload_photo_${i}`);
      const r = await advanceFacebook(c);
      expect(r.kind).toBe("continue");
      state = (r as { state: unknown }).state;
    }
    expect(state).toEqual({ v: 1, photoIds: ["ph1", "ph2", "ph3"] });
    const last = await advanceFacebook(ctx("trip", 3, state));
    expect(last).toMatchObject({ kind: "done", externalId: `${PAGE}_77` });
    const reqs = graph.requests;
    expect(reqs.slice(0, 3).every((r) => r.params.published === "false")).toBe(true);
    expect(reqs[3]!.params.message).toBe("trip");
    expect(JSON.parse(reqs[3]!.params.attached_media!)).toEqual([{ media_fbid: "ph1" }, { media_fbid: "ph2" }, { media_fbid: "ph3" }]);
    expect(paths()).toEqual([`/${PAGE}/photos`, `/${PAGE}/photos`, `/${PAGE}/photos`, `/${PAGE}/feed`]);
  });

  it("never sends scheduled_publish_time or published=false on a publishing request", async () => {
    graph.fallback({ kind: "ok", body: { id: "x" } });
    await advanceFacebook(ctx("a", 0));
    await advanceFacebook(ctx("a", 1));
    for (const r of graph.requests) {
      expect(r.params).not.toHaveProperty("scheduled_publish_time");
      expect(r.params).not.toHaveProperty("published");
    }
  });

  it("refuses a mismatched step without sending", async () => {
    const r = await advanceFacebook(ctx("a", 0, null, "publish_photo"));
    expect(r).toMatchObject({ kind: "fatal_error", error: "The post changed while publishing." });
    expect(graph.requests).toHaveLength(0);
  });

  it("flags unreadable credentials without sending", async () => {
    const c = ctx("a", 0);
    c.account.credentials = { nope: 1 };
    expect(await advanceFacebook(c)).toMatchObject({ kind: "fatal_error", credentialsInvalid: true });
    expect(graph.requests).toHaveLength(0);
  });

  it("is ambiguous when a publishing 2xx has no id; an upload without id retries", async () => {
    graph.fallback({ kind: "missing_id" });
    expect((await advanceFacebook(ctx("a", 0))).kind).toBe("ambiguous");
    expect((await advanceFacebook(ctx("a", 2))).kind).toBe("retryable_error");
  });

  it("adds the public-URL hint to a rejected photo", async () => {
    graph.fallback({ kind: "graph_error", code: 100, message: "Could not fetch image" });
    const r = await advanceFacebook(ctx("a", 1));
    expect(r).toMatchObject({ kind: "fatal_error" });
    expect((r as { error: string }).error).toContain(docsUrl("storage"));
  });

  it("does not leak the token in results", async () => {
    graph.fallback({ kind: "graph_error", code: 100, message: `bad ${TOKEN}` });
    expect(JSON.stringify(await advanceFacebook(ctx("a", 0)))).not.toContain(TOKEN);
  });
});
