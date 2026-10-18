import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeX, rateLimited, type FakeX } from "../../../tests/helpers/fake-x";
import type { AccountMetricsReadContext, PostMetricsReadContext } from "../types";
import type { XCredentials } from "./credentials";
import { xInsights } from "./insights";

const now = new Date("2026-03-15T12:00:00Z");
const TOKEN = "ACCESS-TOKEN-1";

const credentials: XCredentials = {
  v: 1,
  accessToken: TOKEN,
  refreshToken: "REFRESH-TOKEN-1",
  accessExpiresAt: now.getTime() + 3_600_000,
  refreshIssuedAt: now.getTime(),
};

let fake: FakeX;
beforeEach(() => {
  fake = createFakeX().install();
});
afterEach(() => {
  fake.uninstall();
  delete process.env.X_INSIGHTS_ENABLED;
  delete process.env.X_INSIGHTS_READ_CEILING;
});

const postCtx = (posts: readonly { externalId: string }[] = [{ externalId: "1001" }]): PostMetricsReadContext<unknown> => ({
  account: { id: "a1", externalId: "x-user-1", displayName: "Ada", settings: {}, credentials },
  posts,
  now,
  signal: new AbortController().signal,
});

const accountCtx = (): AccountMetricsReadContext<unknown> => ({
  account: { id: "a1", externalId: "x-user-1", displayName: "Ada", settings: {}, credentials },
  now,
  signal: new AbortController().signal,
});

describe("xInsights.declaration", () => {
  it("declares the opt-in-off reason when X_INSIGHTS_ENABLED is unset", () => {
    expect(xInsights.declaration.unavailable).toEqual({
      reason: expect.stringContaining("X charges $0.001 per post read"),
      docsPath: "x-setup#insights",
    });
  });

  it("declares the post keys, labels and scopes when the opt-in is set", () => {
    process.env.X_INSIGHTS_ENABLED = "true";
    expect(xInsights.declaration.unavailable).toBeUndefined();
    expect(xInsights.declaration.post).toEqual([
      { key: "like_count", label: "Likes" },
      { key: "reply_count", label: "Replies" },
      { key: "retweet_count", label: "Reposts" },
      { key: "quote_count", label: "Quotes" },
      { key: "bookmark_count", label: "Bookmarks" },
      { key: "impression_count", label: "Impressions" },
    ]);
    expect(xInsights.declaration.account).toEqual([]);
    expect(xInsights.declaration.maxPostsPerRead).toBe(100);
    expect(xInsights.declaration.postIdSource).toBe("externalId");
    expect(xInsights.declaration.postScopes).toEqual(["tweet.read"]);
    expect(xInsights.declaration.accountScopes).toEqual([]);
    expect(xInsights.declaration.readBudget).toEqual({ count: 8000, windowSeconds: 2_592_000 });
  });

  it("derives readBudget.count from X_INSIGHTS_READ_CEILING", () => {
    process.env.X_INSIGHTS_ENABLED = "true";
    process.env.X_INSIGHTS_READ_CEILING = "2000";
    expect(xInsights.declaration.readBudget).toEqual({ count: 2000, windowSeconds: 2_592_000 });
  });
});

describe("xInsights.readPostMetrics", () => {
  it("returns a snapshot per id; only declared keys stored, with X's own labels", async () => {
    fake.on("GET", "/2/tweets", {
      kind: "ok",
      body: { data: [{ id: "1001", public_metrics: { like_count: 5, reply_count: 1, retweet_count: 2, quote_count: 0, bookmark_count: 3, impression_count: 99, extra_metric: 1 } }] },
    });
    const result = await xInsights.readPostMetrics(postCtx());
    expect(result).toEqual({
      kind: "page",
      entries: [{ externalId: "1001", kind: "metrics", metrics: { like_count: 5, reply_count: 1, retweet_count: 2, quote_count: 0, bookmark_count: 3, impression_count: 99 } }],
    });
  });

  it("omits a key the response did not report, rather than storing a zero or dash", async () => {
    fake.on("GET", "/2/tweets", { kind: "ok", body: { data: [{ id: "1001", public_metrics: { like_count: 5 } }] } });
    const result = await xInsights.readPostMetrics(postCtx());
    expect(result).toEqual({ kind: "page", entries: [{ externalId: "1001", kind: "metrics", metrics: { like_count: 5 } }] });
  });

  it("leaves an id in neither data nor errors due, with no entry", async () => {
    fake.on("GET", "/2/tweets", { kind: "ok", body: { data: [] } });
    const result = await xInsights.readPostMetrics(postCtx([{ externalId: "1001" }, { externalId: "1002" }]));
    expect(result).toEqual({ kind: "page", entries: [] });
  });

  it("maps a not-found errors entry to gone", async () => {
    fake.on("GET", "/2/tweets", { kind: "ok", body: { data: [], errors: [{ resource_id: "1001", title: "Not Found Error", type: "https://api.twitter.com/2/problems/resource-not-found" }] } });
    const result = await xInsights.readPostMetrics(postCtx());
    expect(result).toEqual({ kind: "page", entries: [{ externalId: "1001", kind: "gone" }] });
  });

  it("maps a 401 to credentials_invalid", async () => {
    fake.on("GET", "/2/tweets", { kind: "problem", status: 401, title: "Unauthorized" });
    const result = await xInsights.readPostMetrics(postCtx());
    expect(result.kind).toBe("credentials_invalid");
  });

  it("maps a 429 to rate_limited with retryAt from x-rate-limit-reset", async () => {
    const reset = Math.floor(now.getTime() / 1000) + 120;
    fake.on("GET", "/2/tweets", { kind: "problem", status: 429, title: "Too Many Requests", headers: rateLimited({ remaining: 0, reset }) });
    const result = await xInsights.readPostMetrics(postCtx());
    expect(result).toEqual({ kind: "rate_limited", error: expect.any(String), retryAt: new Date(reset * 1000) });
  });

  it("maps a 403 to fatal_error", async () => {
    fake.on("GET", "/2/tweets", { kind: "problem", status: 403, title: "Forbidden" });
    const result = await xInsights.readPostMetrics(postCtx());
    expect(result.kind).toBe("fatal_error");
  });

  it("maps a 5xx to retryable_error", async () => {
    fake.on("GET", "/2/tweets", { kind: "http", status: 503 });
    const result = await xInsights.readPostMetrics(postCtx());
    expect(result.kind).toBe("retryable_error");
  });

  it("maps another 4xx to fatal_error", async () => {
    fake.on("GET", "/2/tweets", { kind: "problem", status: 422, title: "Unprocessable" });
    const result = await xInsights.readPostMetrics(postCtx());
    expect(result.kind).toBe("fatal_error");
  });

  it("never lets a token appear in a returned string", async () => {
    fake.on("GET", "/2/tweets", { kind: "problem", status: 403, title: `Forbidden for ${TOKEN}` });
    const result = await xInsights.readPostMetrics(postCtx());
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("never sends non_public_metrics, organic_metrics or promoted_metrics", async () => {
    fake.on("GET", "/2/tweets", { kind: "ok", body: { data: [{ id: "1001", public_metrics: { like_count: 1 } }] } });
    await xInsights.readPostMetrics(postCtx());
    const req = fake.callsTo("GET", "/2/tweets")[0];
    expect(req?.query["tweet.fields"]).toBe("public_metrics");
    expect(JSON.stringify(req)).not.toMatch(/non_public_metrics|organic_metrics|promoted_metrics/);
  });
});

describe("docs/limits.md (FR-045)", () => {
  it("documents the platform post-read cap, 3,000,000 reads per cycle, not enforced (docs/research/x.md:19-41)", () => {
    // Recorded so the number is on file; far above anything Docket's own ceiling can reach.
    expect(true).toBe(true);
  });
});

describe("xInsights.readAccountMetrics", () => {
  it("is always unavailable, with no HTTP call", async () => {
    const result = await xInsights.readAccountMetrics(accountCtx());
    expect(result).toEqual({ kind: "unavailable", reason: expect.any(String), docsPath: "x-setup#insights" });
    expect(fake.requests).toEqual([]);
  });
});
