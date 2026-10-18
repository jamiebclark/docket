import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeGraph, type FakeGraph } from "../../../tests/helpers/fake-graph";
import type { AccountMetricsReadContext, PostMetricsReadContext } from "../types";
import { FACEBOOK_ACCOUNT_METRICS, FACEBOOK_POST_METRICS, FACEBOOK_PROHIBITED_METRICS, facebookInsights } from "./insights";
import type { FacebookSettings } from "./settings";

const PAGE = "900000000000000";
const POST = `${PAGE}_123456789012345`;
const VIDEO_ID = "456789012345678";
const TOKEN = "EAAB-page-token-0123456789abcdef";
const now = new Date("2026-01-01T12:00:00Z");

let graph: FakeGraph;
beforeEach(() => {
  graph = createFakeGraph().install();
});
afterEach(() => graph.uninstall());

const p = (path: string) => `/v26.0${path}`;

const postCtx = (posts: readonly { externalId: string }[] = [{ externalId: POST }]): PostMetricsReadContext<FacebookSettings> => ({
  account: { id: "a1", externalId: PAGE, displayName: "Page", settings: {}, credentials: { pageToken: TOKEN } },
  posts,
  now,
  signal: new AbortController().signal,
});

const accountCtx = (): AccountMetricsReadContext<FacebookSettings> => ({
  account: { id: "a1", externalId: PAGE, displayName: "Page", settings: {}, credentials: { pageToken: TOKEN } },
  now,
  signal: new AbortController().signal,
});

describe("facebookInsights declaration", () => {
  it("declares every CONFIRMED post metric and no prohibited one", () => {
    const keys = facebookInsights.declaration.post.map((m) => m.key);
    expect(keys).toEqual([...FACEBOOK_POST_METRICS]);
    for (const prohibited of FACEBOOK_PROHIBITED_METRICS) expect(keys).not.toContain(prohibited);
  });

  it("declares every CONFIRMED account metric and no prohibited one", () => {
    const keys = facebookInsights.declaration.account.map((m) => m.key);
    expect(keys).toEqual([...FACEBOOK_ACCOUNT_METRICS]);
    for (const prohibited of FACEBOOK_PROHIBITED_METRICS) expect(keys).not.toContain(prohibited);
  });

  it("requires pages_read_engagement and read_insights", () => {
    expect(facebookInsights.declaration.requiredScopes).toEqual(["pages_read_engagement", "read_insights"]);
  });

  it("declares no ephemeral post types (Facebook Page Stories are out of scope)", () => {
    expect(facebookInsights.declaration.ephemeralPostTypes).toBeUndefined();
  });
});

describe("facebookInsights.readPostMetrics", () => {
  it("maps a metrics response to `page`/`metrics`, and never requests a prohibited metric (FR-004)", async () => {
    graph.on("GET", p(`/${POST}/insights`), {
      kind: "ok",
      body: { data: [{ name: "post_reactions_by_type_total", values: [{ value: 10 }] }, { name: "post_clicks", values: [{ value: 3 }] }] },
    });
    const r = await facebookInsights.readPostMetrics(postCtx());
    expect(r).toEqual({ kind: "page", entries: [{ externalId: POST, kind: "metrics", metrics: { post_reactions_by_type_total: 10, post_clicks: 3 } }] });
    const metricParam = graph.requests[0]!.params.metric!;
    for (const prohibited of FACEBOOK_PROHIBITED_METRICS) expect(metricParam).not.toContain(prohibited);
  });

  it("treats a declared metric with an empty values array as absent, not zero (FR-035)", async () => {
    graph.on("GET", p(`/${POST}/insights`), { kind: "ok", body: { data: [{ name: "post_clicks", values: [] }] } });
    const r = await facebookInsights.readPostMetrics(postCtx());
    expect(r).toEqual({ kind: "page", entries: [{ externalId: POST, kind: "metrics", metrics: {} }] });
  });

  it("maps Graph code 100 to `gone`, not a failure", async () => {
    graph.on("GET", p(`/${POST}/insights`), { kind: "graph_error", code: 100, message: "Unsupported get request." });
    const r = await facebookInsights.readPostMetrics(postCtx());
    expect(r).toEqual({ kind: "page", entries: [{ externalId: POST, kind: "gone" }] });
  });

  it("maps Graph code 190 to credentials_invalid, with no credential in the message (FR-033, FR-037)", async () => {
    graph.on("GET", p(`/${POST}/insights`), { kind: "graph_error", code: 190, message: `Token ${TOKEN} expired` });
    const r = await facebookInsights.readPostMetrics(postCtx());
    expect(r.kind).toBe("credentials_invalid");
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("maps a rate-limit Graph code to retryable (research §5)", async () => {
    graph.on("GET", p(`/${POST}/insights`), { kind: "graph_error", code: 80002, message: "Business use case limit reached" });
    const r = await facebookInsights.readPostMetrics(postCtx());
    expect(r.kind).toBe("rate_limited");
  });

  it("maps an unrecognised Graph error to fatal_error", async () => {
    graph.on("GET", p(`/${POST}/insights`), { kind: "graph_error", code: 999, message: "Invalid metric post_impressions" });
    const r = await facebookInsights.readPostMetrics(postCtx());
    expect(r.kind).toBe("fatal_error");
  });

  it("maps a network failure to retryable_error and never throws (FR-033)", async () => {
    graph.on("GET", p(`/${POST}/insights`), { kind: "pre_send_failure" });
    const r = await facebookInsights.readPostMetrics(postCtx());
    expect(r.kind).toBe("retryable_error");
  });

  it("returns credentials_invalid without a request when the stored token is unreadable", async () => {
    const r = await facebookInsights.readPostMetrics({ ...postCtx(), account: { ...postCtx().account, credentials: {} } });
    expect(r.kind).toBe("credentials_invalid");
    expect(graph.requests).toHaveLength(0);
  });

  it("classifies a bare video id as unqueryable without issuing a request (FR-036)", async () => {
    const r = await facebookInsights.readPostMetrics(postCtx([{ externalId: VIDEO_ID }]));
    expect(r).toEqual({
      kind: "page",
      entries: [
        {
          externalId: VIDEO_ID,
          kind: "unqueryable",
          reason: "This Reel was published as a video id, which Facebook's post insights cannot read.",
        },
      ],
    });
    expect(graph.requests).toHaveLength(0);
  });

  it("classifies an id matching neither shape as unqueryable, unrecognised", async () => {
    const r = await facebookInsights.readPostMetrics(postCtx([{ externalId: "not-an-id" }]));
    expect(r).toEqual({
      kind: "page",
      entries: [
        {
          externalId: "not-an-id",
          kind: "unqueryable",
          reason: "This id is not a recognised Facebook post or video id, so it cannot be read.",
        },
      ],
    });
    expect(graph.requests).toHaveLength(0);
  });
});

describe("facebookInsights.readAccountMetrics", () => {
  it("maps a metrics response to `page`, filtered to declared keys", async () => {
    graph.on("GET", p(`/${PAGE}/insights`), {
      kind: "ok",
      body: { data: [{ name: "page_post_engagements", values: [{ value: 100 }] }, { name: "page_follows", values: [{ value: 5 }] }] },
    });
    const r = await facebookInsights.readAccountMetrics(accountCtx());
    expect(r).toEqual({ kind: "page", metrics: { page_post_engagements: 100, page_follows: 5 } });
  });
});
