import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeGraph, type FakeGraph } from "../../../tests/helpers/fake-graph";
import type { MediaItem, PublishContext } from "../types";
import { advanceInstagram } from "./publish";
import { CONTAINER_SAFE_AGE_MS, initialState, PROCESSING_CAP_MS, type InstagramState } from "./state";
import { instagramStepFor } from "./steps";

const IG = "17841400000000000";
const TOKEN = "EAAB-page-token-0123456789abcdef";
const now = new Date("2026-01-01T12:00:00Z");
const img = (n: number, altText = ""): MediaItem => ({ url: `https://media.test/${n}.jpg`, mimeType: "image/jpeg", width: 10, height: 10, bytes: 100, altText });

let graph: FakeGraph;
beforeEach(() => {
  graph = createFakeGraph().install();
});
afterEach(() => graph.uninstall());

const st = (count: number, patch: Partial<InstagramState> = {}): InstagramState => ({ ...initialState(count), ...patch });
const createdAgo = (ms: number) => new Date(now.getTime() - ms).toISOString();

function ctx(opts: { text?: string; media?: MediaItem[]; state?: unknown; at?: Date }): PublishContext {
  const media = opts.media ?? [img(1)];
  const text = opts.text ?? "caption";
  const state = opts.state ?? null;
  return {
    target: { id: "t1", scheduledAt: now, attempt: 1 },
    account: { id: "a1", externalId: IG, displayName: "IG", settings: {}, credentials: { pageToken: TOKEN } },
    content: { text, media },
    postType: media.length === 1 ? "image" : "carousel",
    step: instagramStepFor(state, { text, mediaCount: media.length }),
    state,
    now: opts.at ?? now,
    signal: new AbortController().signal,
  };
}

const p = (path: string) => `/v26.0${path}`;
const lastReq = () => graph.requests[graph.requests.length - 1]!;

describe("create steps", () => {
  it("creates a single container with caption and alt_text, then waits 10 s", async () => {
    graph.on("POST", p(`/${IG}/media`), { kind: "ok", body: { id: "c1" } });
    const r = await advanceInstagram(ctx({ media: [img(1, "a dog")] }));
    expect(graph.requests[0]!.params).toEqual({ image_url: "https://media.test/1.jpg", caption: "caption", alt_text: "a dog", access_token: "[redacted]" });
    expect(r).toMatchObject({ kind: "continue", state: { container: "c1", createdAt: now.toISOString(), checks: 0, ready: false } });
    expect(r.kind === "continue" && r.notBefore).toEqual(new Date(now.getTime() + 10_000));
  });

  it("omits empty caption and alt_text", async () => {
    graph.on("POST", p(`/${IG}/media`), { kind: "ok", body: { id: "c1" } });
    await advanceInstagram(ctx({ text: "" }));
    expect(Object.keys(graph.requests[0]!.params).sort()).toEqual(["access_token", "image_url"]);
  });

  it("creates carousel items without a caption, in order, with no delay", async () => {
    graph.on("POST", p(`/${IG}/media`), { kind: "ok", body: { id: "i1" } });
    const media = [img(1, "one"), img(2), img(3)];
    const r = await advanceInstagram(ctx({ media }));
    expect(graph.requests[0]!.params).toEqual({ image_url: "https://media.test/1.jpg", is_carousel_item: "true", alt_text: "one", access_token: "[redacted]" });
    expect(r).toMatchObject({ kind: "continue", state: { items: ["i1"] } });
    expect(r.kind === "continue" && r.notBefore).toBeUndefined();
    const r2 = await advanceInstagram(ctx({ media, state: st(3, { items: ["i1"] }) }));
    expect(lastReq().params.image_url).toBe("https://media.test/2.jpg");
    expect(r2).toMatchObject({ state: { items: ["i1", "i1"] } });
  });

  it("creates the carousel container with children and caption", async () => {
    graph.on("POST", p(`/${IG}/media`), { kind: "ok", body: { id: "k1" } });
    const r = await advanceInstagram(ctx({ media: [img(1), img(2)], state: st(2, { items: ["a", "b"] }) }));
    expect(graph.requests[0]!.params).toEqual({ media_type: "CAROUSEL", children: "a,b", caption: "caption", access_token: "[redacted]" });
    expect(r).toMatchObject({ kind: "continue", state: { container: "k1" } });
  });

  it("a 2xx without an id is retryable, not ambiguous", async () => {
    graph.on("POST", p(`/${IG}/media`), { kind: "missing_id" });
    expect(await advanceInstagram(ctx({}))).toMatchObject({ kind: "retryable_error" });
  });

  it("a fetch-failure rejection gets the public-URL hint", async () => {
    graph.on("POST", p(`/${IG}/media`), { kind: "graph_error", code: 9004, message: "Only photo or video can be accepted as media type. Could not fetch image URL", status: 400 });
    const r = await advanceInstagram(ctx({}));
    expect(r).toMatchObject({ kind: "fatal_error" });
    expect(r.kind === "fatal_error" && r.error).toContain("public URL");
  });

  it("an invalid token is fatal with credentialsInvalid", async () => {
    graph.on("POST", p(`/${IG}/media`), { kind: "graph_error", code: 190, status: 400 });
    expect(await advanceInstagram(ctx({}))).toMatchObject({ kind: "fatal_error", credentialsInvalid: true });
  });

  it("missing credentials send nothing", async () => {
    const c = ctx({});
    c.account.credentials = null;
    expect(await advanceInstagram(c)).toMatchObject({ kind: "fatal_error", credentialsInvalid: true });
    expect(graph.requests).toHaveLength(0);
  });
});

describe("check_status", () => {
  const base = (patch: Partial<InstagramState> = {}) => st(1, { container: "c1", createdAt: createdAgo(30_000), ...patch });
  const run = (code: unknown, patch: Partial<InstagramState> = {}, at = now) => {
    graph.on("GET", p("/c1"), { kind: "ok", body: code === undefined ? {} : { status_code: code } });
    return advanceInstagram(ctx({ state: base(patch), at }));
  };

  it("requests status_code and backs off 10 s doubling to 5 min", async () => {
    const r = await run("IN_PROGRESS");
    expect(graph.requests[0]!.params).toEqual({ fields: "status_code", access_token: "[redacted]" });
    expect(r).toMatchObject({ kind: "continue", state: { checks: 1, ready: false } });
    expect(r.kind === "continue" && r.notBefore).toEqual(new Date(now.getTime() + 10_000));
    const delays: number[] = [];
    for (const checks of [1, 2, 3, 5, 6, 12]) {
      const x = await run("IN_PROGRESS", { checks });
      delays.push(x.kind === "continue" ? x.notBefore!.getTime() - now.getTime() : -1);
    }
    expect(delays).toEqual([20_000, 40_000, 80_000, 300_000, 300_000, 300_000]);
  });

  it("FINISHED marks the container ready", async () => {
    expect(await run("FINISHED")).toMatchObject({ kind: "continue", state: { ready: true } });
  });

  it("ERROR is fatal", async () => {
    expect(await run("ERROR")).toMatchObject({ kind: "fatal_error" });
  });

  it("PUBLISHED before our publish is ambiguous", async () => {
    expect(await run("PUBLISHED")).toMatchObject({ kind: "ambiguous" });
  });

  it("an unknown or missing status is retryable", async () => {
    expect(await run("WAT")).toMatchObject({ kind: "retryable_error", error: "Instagram returned an unknown media status." });
    expect(await run(undefined)).toMatchObject({ kind: "retryable_error" });
  });

  it("EXPIRED recreates from step one, counting recreations, then is fatal at the cap", async () => {
    const r = await run("EXPIRED", { items: [], recreations: 1 });
    expect(r).toMatchObject({ kind: "continue", state: { container: null, createdAt: null, recreations: 2, ready: false, mediaType: "IMAGE" } });
    const capped = await run("EXPIRED", { recreations: 2 });
    expect(capped).toMatchObject({ kind: "fatal_error" });
    expect(capped.kind === "fatal_error" && capped.error).toContain("tried 3 times");
  });

  it("recreating a carousel starts over at the first item", async () => {
    graph.on("GET", p("/c1"), { kind: "ok", body: { status_code: "EXPIRED" } });
    const r = await advanceInstagram(ctx({ media: [img(1), img(2)], state: st(2, { items: ["a", "b"], container: "c1", createdAt: createdAgo(1000) }) }));
    expect(r).toMatchObject({ kind: "continue", state: { mediaType: "CAROUSEL", items: [], container: null, recreations: 1 } });
  });

  it("IN_PROGRESS stops after the 60-minute cap using ctx.now", async () => {
    const created = createdAgo(0);
    graph.on("GET", p("/c1"), { kind: "ok", body: { status_code: "IN_PROGRESS" } });
    const under = new Date(now.getTime() + PROCESSING_CAP_MS - 1);
    const at = new Date(now.getTime() + PROCESSING_CAP_MS);
    const state = st(1, { container: "c1", createdAt: created });
    expect(await advanceInstagram(ctx({ state, at: under }))).toMatchObject({ kind: "continue" });
    const r = await advanceInstagram(ctx({ state, at }));
    expect(r).toMatchObject({ kind: "fatal_error", error: "Instagram did not finish processing the media." });
  });
});

describe("check_quota", () => {
  const state = (patch: Partial<InstagramState> = {}) => st(1, { container: "c1", ready: true, createdAt: createdAgo(60_000), ...patch });
  const quotaBody = (usage: number, total = 100) => ({ data: [{ quota_usage: usage, config: { quota_total: total, quota_duration: 86400 } }] });

  it("proceeds when under the limit", async () => {
    graph.on("GET", p(`/${IG}/content_publishing_limit`), { kind: "ok", body: quotaBody(12) });
    const r = await advanceInstagram(ctx({ state: state() }));
    expect(graph.requests[0]!.params.fields).toBe("quota_usage,config");
    expect(r).toMatchObject({ kind: "continue", state: { quotaChecked: true }, summary: { response: { quotaUsage: 12, quotaTotal: 100 } } });
  });

  it("is retryable an hour later when full, leaving state alone", async () => {
    graph.on("GET", p(`/${IG}/content_publishing_limit`), { kind: "ok", body: quotaBody(100) });
    const r = await advanceInstagram(ctx({ state: state() }));
    expect(r).toMatchObject({ kind: "retryable_error", summary: { response: { quotaUsage: 100, quotaTotal: 100 } } });
    expect(r.kind === "retryable_error" && r.notBefore).toEqual(new Date(now.getTime() + 3_600_000));
  });

  it("proceeds with quota unknown on an unreadable body or a non-token failure", async () => {
    for (const reply of [{ kind: "ok", body: { data: [] } }, { kind: "graph_error", code: 100, status: 400 }, { kind: "http", status: 500 }] as const) {
      graph.reset();
      graph.on("GET", p(`/${IG}/content_publishing_limit`), reply);
      expect(await advanceInstagram(ctx({ state: state() }))).toMatchObject({
        kind: "continue",
        state: { quotaChecked: true },
        summary: { response: { quota: "unknown" } },
      });
    }
  });

  it("an invalid token is fatal", async () => {
    graph.on("GET", p(`/${IG}/content_publishing_limit`), { kind: "graph_error", code: 190, status: 400 });
    expect(await advanceInstagram(ctx({ state: state() }))).toMatchObject({ kind: "fatal_error", credentialsInvalid: true });
  });

  it("recreates a container 23 h old or older without a request", async () => {
    const r = await advanceInstagram(ctx({ state: state({ createdAt: createdAgo(CONTAINER_SAFE_AGE_MS) }) }));
    expect(r).toMatchObject({ kind: "continue", state: { container: null, recreations: 1 } });
    expect(graph.requests).toHaveLength(0);
    const capped = await advanceInstagram(ctx({ state: state({ createdAt: createdAgo(CONTAINER_SAFE_AGE_MS), recreations: 2 }) }));
    expect(capped).toMatchObject({ kind: "fatal_error" });
  });
});

describe("publish", () => {
  const state = st(1, { container: "c1", ready: true, quotaChecked: true, createdAt: createdAgo(60_000) });

  it("sends one media_publish with creation_id and finishes with the media id", async () => {
    graph.on("POST", p(`/${IG}/media_publish`), { kind: "ok", body: { id: "m9" } });
    const r = await advanceInstagram(ctx({ state }));
    expect(graph.requests).toHaveLength(1);
    expect(graph.requests[0]!.params).toEqual({ creation_id: "c1", access_token: "[redacted]" });
    expect(r).toMatchObject({ kind: "done", externalId: "m9" });
    expect(r.kind === "done" && r.url).toBeUndefined();
  });

  it("is ambiguous without an id, on a reset, on 5xx and on temporary codes", async () => {
    for (const reply of [{ kind: "missing_id" }, { kind: "reset_mid_body" }, { kind: "http", status: 503 }, { kind: "graph_error", code: 2, status: 500 }] as const) {
      graph.reset();
      graph.on("POST", p(`/${IG}/media_publish`), reply);
      expect((await advanceInstagram(ctx({ state }))).kind).toBe("ambiguous");
    }
  });

  it("a rejection is fatal with the retry hint and never recreates", async () => {
    graph.on("POST", p(`/${IG}/media_publish`), { kind: "graph_error", code: 100, message: "Media ID is not available", status: 400 });
    const r = await advanceInstagram(ctx({ state }));
    expect(r).toMatchObject({ kind: "fatal_error" });
    expect(r.kind === "fatal_error" && r.error).toMatch(/Media ID is not available.*Retry the post to create the media again\.$/);
    expect(graph.requests).toHaveLength(1);
  });

  it("a rate-limit code is retryable", async () => {
    graph.on("POST", p(`/${IG}/media_publish`), { kind: "graph_error", code: 4, status: 400 });
    expect((await advanceInstagram(ctx({ state }))).kind).toBe("retryable_error");
  });

  it("refuses a step that does not match the state", async () => {
    const c = ctx({ state });
    c.step = { name: "create_container", mayPublish: false };
    expect(await advanceInstagram(c)).toMatchObject({ kind: "fatal_error", error: "The post changed while publishing." });
  });
});
