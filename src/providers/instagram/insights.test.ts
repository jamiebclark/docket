import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeGraph, type FakeGraph } from "../../../tests/helpers/fake-graph";
import type { AccountMetricsReadContext, PostMetricsReadContext } from "../types";
import { INSTAGRAM_ACCOUNT_METRICS, INSTAGRAM_POST_METRICS, INSTAGRAM_PROHIBITED_METRICS, instagramInsights } from "./insights";
import type { InstagramSettings } from "./settings";

const IG = "17841400000000000";
const MEDIA = "18000000000000000";
const TOKEN = "EAAB-page-token-0123456789abcdef";
const now = new Date("2026-01-01T12:00:00Z");

let graph: FakeGraph;
beforeEach(() => {
  graph = createFakeGraph().install();
});
afterEach(() => graph.uninstall());

const p = (path: string) => `/v26.0${path}`;

const postCtx = (posts: readonly { externalId: string }[] = [{ externalId: MEDIA }]): PostMetricsReadContext<InstagramSettings> => ({
  account: { id: "a1", externalId: IG, displayName: "IG", settings: {}, credentials: { pageToken: TOKEN } },
  posts,
  now,
  signal: new AbortController().signal,
});

const accountCtx = (): AccountMetricsReadContext<InstagramSettings> => ({
  account: { id: "a1", externalId: IG, displayName: "IG", settings: {}, credentials: { pageToken: TOKEN } },
  now,
  signal: new AbortController().signal,
});

describe("instagramInsights declaration", () => {
  it("declares every CONFIRMED post metric and no prohibited one", () => {
    const keys = instagramInsights.declaration.post.map((m) => m.key);
    expect(keys).toEqual([...INSTAGRAM_POST_METRICS]);
    for (const prohibited of INSTAGRAM_PROHIBITED_METRICS) expect(keys).not.toContain(prohibited);
  });

  it("declares every CONFIRMED account metric and no prohibited one", () => {
    const keys = instagramInsights.declaration.account.map((m) => m.key);
    expect(keys).toEqual([...INSTAGRAM_ACCOUNT_METRICS]);
    for (const prohibited of INSTAGRAM_PROHIBITED_METRICS) expect(keys).not.toContain(prohibited);
  });

  it("requires the three documented scopes", () => {
    expect(instagramInsights.declaration.requiredScopes).toEqual([
      "instagram_basic",
      "instagram_manage_insights",
      "pages_read_engagement",
    ]);
  });

  it("declares a 48,000/86,400s read budget, interim and UNVERIFIED (research §4)", () => {
    expect(instagramInsights.declaration.readBudget).toEqual({ count: 48_000, windowSeconds: 86_400 });
  });
});

describe("instagramInsights.readPostMetrics", () => {
  it("maps a metrics response to `page`/`metrics`, and never requests a prohibited metric (FR-004)", async () => {
    graph.on("GET", p(`/${MEDIA}/insights`), {
      kind: "ok",
      body: { data: [{ name: "views", values: [{ value: 10 }] }, { name: "likes", values: [{ value: 3 }] }] },
    });
    const r = await instagramInsights.readPostMetrics(postCtx());
    expect(r).toEqual({ kind: "page", entries: [{ externalId: MEDIA, kind: "metrics", metrics: { views: 10, likes: 3 } }] });
    const metricParam = graph.requests[0]!.params.metric!;
    for (const prohibited of INSTAGRAM_PROHIBITED_METRICS) expect(metricParam).not.toContain(prohibited);
  });

  it("treats a declared metric with an empty values array as absent, not zero (FR-035)", async () => {
    graph.on("GET", p(`/${MEDIA}/insights`), { kind: "ok", body: { data: [{ name: "views", values: [] }] } });
    const r = await instagramInsights.readPostMetrics(postCtx());
    expect(r).toEqual({ kind: "page", entries: [{ externalId: MEDIA, kind: "metrics", metrics: {} }] });
  });

  it("maps Graph code 100 to `gone`, not a failure", async () => {
    graph.on("GET", p(`/${MEDIA}/insights`), { kind: "graph_error", code: 100, message: "Unsupported get request." });
    const r = await instagramInsights.readPostMetrics(postCtx());
    expect(r).toEqual({ kind: "page", entries: [{ externalId: MEDIA, kind: "gone" }] });
  });

  it("maps Graph code 190 to credentials_invalid, with no credential in the message (FR-033, FR-037)", async () => {
    graph.on("GET", p(`/${MEDIA}/insights`), { kind: "graph_error", code: 190, message: `Token ${TOKEN} expired` });
    const r = await instagramInsights.readPostMetrics(postCtx());
    expect(r.kind).toBe("credentials_invalid");
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("maps a rate-limit Graph code to retryable (research §5)", async () => {
    graph.on("GET", p(`/${MEDIA}/insights`), { kind: "graph_error", code: 80002, message: "Business use case limit reached" });
    const r = await instagramInsights.readPostMetrics(postCtx());
    expect(r.kind).toBe("rate_limited");
  });

  it("maps an unrecognised Graph error to fatal_error", async () => {
    graph.on("GET", p(`/${MEDIA}/insights`), { kind: "graph_error", code: 999, message: "Invalid metric views_unsupported" });
    const r = await instagramInsights.readPostMetrics(postCtx());
    expect(r.kind).toBe("fatal_error");
  });

  it("maps a network failure to retryable_error and never throws (FR-033)", async () => {
    graph.on("GET", p(`/${MEDIA}/insights`), { kind: "pre_send_failure" });
    const r = await instagramInsights.readPostMetrics(postCtx());
    expect(r.kind).toBe("retryable_error");
  });

  it("returns credentials_invalid without a request when the stored token is unreadable", async () => {
    const r = await instagramInsights.readPostMetrics({ ...postCtx(), account: { ...postCtx().account, credentials: {} } });
    expect(r.kind).toBe("credentials_invalid");
    expect(graph.requests).toHaveLength(0);
  });
});

describe("instagramInsights.readAccountMetrics", () => {
  it("maps a metrics response to `page`, filtered to declared keys", async () => {
    graph.on("GET", p(`/${IG}/insights`), {
      kind: "ok",
      body: { data: [{ name: "reach", values: [{ value: 100 }] }, { name: "follower_count", values: [{ value: 5 }] }] },
    });
    const r = await instagramInsights.readAccountMetrics(accountCtx());
    expect(r).toEqual({ kind: "page", metrics: { reach: 100, follower_count: 5 } });
    expect(graph.requests[0]!.params.period).toBe("day");
  });

  it("sends metric_type=total_value, which user insights require", async () => {
    graph.on("GET", p(`/${IG}/insights`), { kind: "ok", body: { data: [] } });
    await instagramInsights.readAccountMetrics(accountCtx());
    expect(graph.requests[0]!.params.metric_type).toBe("total_value");
  });

  it("never asks for profile_views, removed by Meta in 2025", async () => {
    graph.on("GET", p(`/${IG}/insights`), { kind: "ok", body: { data: [] } });
    await instagramInsights.readAccountMetrics(accountCtx());
    expect(graph.requests[0]!.params.metric!).not.toContain("profile_views");
  });
});
