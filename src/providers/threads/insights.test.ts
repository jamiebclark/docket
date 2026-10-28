import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeGraph, type FakeGraph } from "../../../tests/helpers/fake-graph";
import type { AccountMetricsReadContext, PostMetricsReadContext } from "../types";
import { THREADS_API_VERSION } from "./config";
import { THREADS_PROHIBITED_METRICS, THREADS_RAW_POST_METRICS, threadsInsights } from "./insights";
import type { ThreadsSettings } from "./settings";

const USER = "17800000000000000";
const MEDIA = "18110903159338862";
const TOKEN = "THAA-threads-token-0123456789abcdef";
const now = new Date("2026-01-01T12:00:00Z");

let graph: FakeGraph;
beforeEach(() => {
  graph = createFakeGraph().install();
});
afterEach(() => graph.uninstall());

const p = (path: string) => `/${THREADS_API_VERSION}${path}`;

const credentials = { v: 1, accessToken: TOKEN, issuedAt: 0, expiresAt: 4_000_000_000, expiryEstimated: false };

const postCtx = (posts: readonly { externalId: string }[] = [{ externalId: MEDIA }]): PostMetricsReadContext<ThreadsSettings> => ({
  account: { id: "a1", externalId: USER, displayName: "Threads", settings: {}, credentials },
  posts,
  now,
  signal: new AbortController().signal,
});

const accountCtx = (): AccountMetricsReadContext<ThreadsSettings> => ({
  account: { id: "a1", externalId: USER, displayName: "Threads", settings: {}, credentials },
  now,
  signal: new AbortController().signal,
});

describe("threadsInsights declaration", () => {
  it("declares every metric in the official enum, each with Threads' own label", () => {
    expect(threadsInsights.declaration.post.map((m) => m.label)).toEqual(["Views", "Likes", "Replies", "Reposts", "Quotes", "Shares"]);
  });

  it("prefixes only the keys that would collide with Instagram's, leaving the rest Threads' own word", () => {
    expect(threadsInsights.declaration.post.map((m) => m.key)).toEqual([
      "threads_views",
      "threads_likes",
      "replies",
      "reposts",
      "quotes",
      "threads_shares",
    ]);
  });

  it("declares every metric as cumulative: Threads reports media insights with period `lifetime`", () => {
    for (const m of threadsInsights.declaration.post) expect(m.shape).toEqual({ kind: "cumulative" });
  });

  it("leaves the account surface undeclared, so it is never claimed (research R4)", () => {
    expect(threadsInsights.declaration.account).toEqual([]);
    expect(threadsInsights.declaration.accountScopes).toBeUndefined();
  });

  it("no longer declares `unavailable`: the metric enum is CONFIRMED, so the surface is read for real", () => {
    expect(threadsInsights.declaration.unavailable).toBeUndefined();
  });

  it("requires threads_manage_insights on the post surface, with a reason that names the permission", () => {
    expect(threadsInsights.declaration.postScopes).toEqual(["threads_manage_insights"]);
    expect(threadsInsights.declaration.missingPostScopes?.reason).toContain("threads_manage_insights");
  });

  it("declares a 48,000/86,400s read budget, sourced from the documented impression floor (research §Q5)", () => {
    expect(threadsInsights.declaration.readBudget).toEqual({ count: 48_000, windowSeconds: 86_400 });
  });
});

describe("threadsInsights.readPostMetrics", () => {
  it("maps a metrics response to `page`/`metrics` under the stored keys, and never asks for a prohibited metric", async () => {
    graph.on("GET", p(`/${MEDIA}/insights`), {
      kind: "ok",
      body: {
        data: [
          { name: "views", period: "lifetime", values: [{ value: 42 }] },
          { name: "likes", period: "lifetime", values: [{ value: 7 }] },
          { name: "replies", period: "lifetime", values: [{ value: 2 }] },
        ],
      },
    });
    const r = await threadsInsights.readPostMetrics(postCtx());
    expect(r).toEqual({
      kind: "page",
      entries: [{ externalId: MEDIA, kind: "metrics", metrics: { threads_views: 42, threads_likes: 7, replies: 2 } }],
    });
    const metricParam = graph.requests[0]!.params.metric!;
    expect(metricParam).toBe(THREADS_RAW_POST_METRICS.join(","));
    for (const prohibited of THREADS_PROHIBITED_METRICS) expect(metricParam).not.toContain(prohibited);
  });

  it("requests Threads' own raw metric names, not the prefixed storage keys Graph would reject", async () => {
    graph.on("GET", p(`/${MEDIA}/insights`), { kind: "ok", body: { data: [] } });
    await threadsInsights.readPostMetrics(postCtx());
    expect(graph.requests[0]!.params.metric).not.toContain("threads_");
  });

  it("leaves an in-development metric that reports nothing absent, never zero (FR-035)", async () => {
    // Meta marks `views` and `shares` "in development": both may simply not come back.
    graph.on("GET", p(`/${MEDIA}/insights`), { kind: "ok", body: { data: [{ name: "likes", values: [{ value: 7 }] }] } });
    const r = await threadsInsights.readPostMetrics(postCtx());
    expect(r).toEqual({ kind: "page", entries: [{ externalId: MEDIA, kind: "metrics", metrics: { threads_likes: 7 } }] });
  });

  it("treats a declared metric with an empty values array as absent, not zero (FR-035)", async () => {
    graph.on("GET", p(`/${MEDIA}/insights`), { kind: "ok", body: { data: [{ name: "likes", values: [] }] } });
    const r = await threadsInsights.readPostMetrics(postCtx());
    expect(r).toEqual({ kind: "page", entries: [{ externalId: MEDIA, kind: "metrics", metrics: {} }] });
  });

  it("maps Graph code 100 to `gone`, not a failure", async () => {
    graph.on("GET", p(`/${MEDIA}/insights`), { kind: "graph_error", code: 100, message: "Unsupported get request." });
    const r = await threadsInsights.readPostMetrics(postCtx());
    expect(r).toEqual({ kind: "page", entries: [{ externalId: MEDIA, kind: "gone" }] });
  });

  it("maps Graph code 190 to credentials_invalid, with no credential in the message (FR-033, FR-037)", async () => {
    graph.on("GET", p(`/${MEDIA}/insights`), { kind: "graph_error", code: 190, message: `Token ${TOKEN} expired` });
    const r = await threadsInsights.readPostMetrics(postCtx());
    expect(r.kind).toBe("credentials_invalid");
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("maps a rate-limit Graph code to rate_limited", async () => {
    graph.on("GET", p(`/${MEDIA}/insights`), { kind: "graph_error", code: 80002, message: "Business use case limit reached" });
    const r = await threadsInsights.readPostMetrics(postCtx());
    expect(r.kind).toBe("rate_limited");
  });

  it("maps an unrecognised Graph error to fatal_error", async () => {
    graph.on("GET", p(`/${MEDIA}/insights`), { kind: "graph_error", code: 999, message: "Invalid metric name" });
    const r = await threadsInsights.readPostMetrics(postCtx());
    expect(r.kind).toBe("fatal_error");
  });

  it("maps a network failure to retryable_error and never throws (FR-033)", async () => {
    graph.on("GET", p(`/${MEDIA}/insights`), { kind: "pre_send_failure" });
    const r = await threadsInsights.readPostMetrics(postCtx());
    expect(r.kind).toBe("retryable_error");
  });

  it("returns credentials_invalid without a request when the stored token is unreadable", async () => {
    const ctx = postCtx();
    const r = await threadsInsights.readPostMetrics({ ...ctx, account: { ...ctx.account, credentials: {} } });
    expect(r.kind).toBe("credentials_invalid");
    expect(graph.requests).toHaveLength(0);
  });
});

describe("threadsInsights.readAccountMetrics", () => {
  it("returns `unavailable` without making a call: the account surface is undeclared", async () => {
    const r = await threadsInsights.readAccountMetrics(accountCtx());
    expect(r).toEqual({ kind: "unavailable", reason: "Docket does not read account-level numbers from Threads.", docsPath: "insights" });
    expect(graph.requests).toHaveLength(0);
  });
});
