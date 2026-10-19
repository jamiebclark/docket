import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakePinterest, type FakePinterest } from "../../../tests/helpers/fake-pinterest";
import type { AccountMetricsReadContext, PostMetricsReadContext } from "../types";
import type { PinterestCredentials } from "./credentials";
import { pinterestInsights } from "./insights";

const now = new Date("2026-03-15T12:00:00Z");
const TOKEN = "ACCESS-TOKEN-1";
const ANALYTICS = "/v5/pins/pin-1/analytics";
const USER_ACCOUNT = "/v5/user_account";

const credentials: PinterestCredentials = {
  v: 1,
  accessToken: TOKEN,
  refreshToken: "REFRESH-TOKEN-1",
  accessExpiresAt: now.getTime() + 2_592_000_000,
  refreshIssuedAt: now.getTime(),
  refreshExpiresAt: now.getTime() + 5_184_000_000,
  refreshExpiryEstimated: false,
};

let fake: FakePinterest;
beforeEach(() => {
  fake = createFakePinterest().install();
});
afterEach(() => fake.uninstall());

const postCtx = (posts: readonly { externalId: string }[] = [{ externalId: "pin-1" }]): PostMetricsReadContext<unknown> => ({
  account: { id: "a1", externalId: "pinterest-user-1", displayName: "Ada", settings: {}, credentials },
  posts,
  now,
  signal: new AbortController().signal,
});

const accountCtx = (): AccountMetricsReadContext<unknown> => ({
  account: { id: "a1", externalId: "pinterest-user-1", displayName: "Ada", settings: {}, credentials },
  now,
  signal: new AbortController().signal,
});

const analyticsBody = (overrides: Record<string, unknown> = {}) => ({
  ALL: { summary_metrics: { IMPRESSION: 240, PIN_CLICK: 37, OUTBOUND_CLICK: 20, SAVE: 20, SAVE_RATE: 0.18, ...overrides } },
});

describe("pinterestInsights.declaration", () => {
  it("declares the post, account and shared fields of contracts/platform-readers-082.md §2", () => {
    expect(pinterestInsights.declaration.post).toEqual([
      { key: "IMPRESSION", label: "Impressions", shape: { kind: "windowed", windowMs: null } },
      { key: "PIN_CLICK", label: "Pin clicks", shape: { kind: "windowed", windowMs: null } },
      { key: "OUTBOUND_CLICK", label: "Outbound clicks", shape: { kind: "windowed", windowMs: null } },
      { key: "SAVE", label: "Saves", shape: { kind: "windowed", windowMs: null } },
    ]);
    expect(pinterestInsights.declaration.account).toEqual([
      { key: "pinterest_follower_count", label: "Followers", shape: { kind: "cumulative" } },
      {
        key: "monthly_views",
        label: "Monthly views",
        // Pinterest does not document the window this covers, so it is declared `unknown` and the
        // trend builder renders no series for it rather than implying a comparable line.
        shape: {
          kind: "unknown",
          reason: "Pinterest does not document the window this number covers, so Docket cannot plot it over time.",
        },
      },
    ]);
    expect(pinterestInsights.declaration.maxPostsPerRead).toBe(1);
    expect(pinterestInsights.declaration.postIdSource).toBe("externalId");
    expect(pinterestInsights.declaration.postScopes).toEqual(["pins:read"]);
    expect(pinterestInsights.declaration.accountScopes).toEqual([]);
  });

  it("declares a 1000/86400s read budget, the org_read Trial figure (FR-033)", () => {
    expect(pinterestInsights.declaration.readBudget).toEqual({ count: 1000, windowSeconds: 86_400 });
  });
});

describe("pinterestInsights.readPostMetrics", () => {
  it("maps a happy page, requesting exactly the declared metric_types and the pure window (contracts/platform-readers-082.md §2, §4)", async () => {
    fake.on("GET", ANALYTICS, { kind: "ok", body: analyticsBody() });
    const r = await pinterestInsights.readPostMetrics(postCtx());
    expect(r).toEqual({ kind: "page", entries: [{ externalId: "pin-1", kind: "metrics", metrics: { IMPRESSION: 240, PIN_CLICK: 37, OUTBOUND_CLICK: 20, SAVE: 20 } }] });
    const req = fake.requests[0]!;
    expect(req.path).toBe(ANALYTICS);
    expect(req.query.metric_types).toBe("IMPRESSION,PIN_CLICK,OUTBOUND_CLICK,SAVE");
    expect(req.query.start_date).toBe("2025-12-15");
    expect(req.query.end_date).toBe("2026-03-15");
  });

  it("a declared metric the response omitted is absent, not zero (§4)", async () => {
    fake.on("GET", ANALYTICS, { kind: "ok", body: { ALL: { summary_metrics: { IMPRESSION: 240 } } } });
    const r = await pinterestInsights.readPostMetrics(postCtx());
    expect(r).toEqual({ kind: "page", entries: [{ externalId: "pin-1", kind: "metrics", metrics: { IMPRESSION: 240 } }] });
  });

  it("a pin whose analytics report no declared metric renders as metrics: {} (nothing_reported downstream), not an error (FR-032)", async () => {
    fake.on("GET", ANALYTICS, { kind: "ok", body: { ALL: { summary_metrics: { SAVE_RATE: 0.1 } } } });
    const r = await pinterestInsights.readPostMetrics(postCtx());
    expect(r).toEqual({ kind: "page", entries: [{ externalId: "pin-1", kind: "metrics", metrics: {} }] });
  });

  it("no ALL key present falls back to the single split value present", async () => {
    fake.on("GET", ANALYTICS, { kind: "ok", body: { MOBILE: { summary_metrics: { IMPRESSION: 5 } } } });
    const r = await pinterestInsights.readPostMetrics(postCtx());
    expect(r).toEqual({ kind: "page", entries: [{ externalId: "pin-1", kind: "metrics", metrics: { IMPRESSION: 5 } }] });
  });

  it("no split key present at all -> metrics: {}", async () => {
    fake.on("GET", ANALYTICS, { kind: "ok", body: {} });
    const r = await pinterestInsights.readPostMetrics(postCtx());
    expect(r).toEqual({ kind: "page", entries: [{ externalId: "pin-1", kind: "metrics", metrics: {} }] });
  });

  it("PINNER_DATA_ACCESS_DENIED (403, message token) -> unavailable with the business-account reason, not credentials_invalid (FR-031)", async () => {
    fake.on("GET", ANALYTICS, { kind: "error", status: 403, message: "PINNER_DATA_ACCESS_DENIED" });
    const r = await pinterestInsights.readPostMetrics(postCtx());
    expect(r).toEqual({
      kind: "unavailable",
      reason: "Pinterest does not give Docket pin analytics for this account; it needs a business account with pinner-data access.",
      docsPath: "pinterest-setup#insights",
    });
  });

  it("401 -> credentials_invalid", async () => {
    fake.on("GET", ANALYTICS, { kind: "error", status: 401 });
    expect(await pinterestInsights.readPostMetrics(postCtx())).toMatchObject({ kind: "credentials_invalid" });
  });

  it("429 -> rate_limited with retryAt from x-ratelimit-reset", async () => {
    fake.on("GET", ANALYTICS, { kind: "error", status: 429, headers: { "x-ratelimit-reset": "30" } });
    const r = await pinterestInsights.readPostMetrics(postCtx());
    expect(r).toMatchObject({ kind: "rate_limited" });
    if (r.kind === "rate_limited") expect(r.retryAt).toEqual(new Date(now.getTime() + 30_000));
  });

  it("404 -> that pin is gone; terminal, not a failure", async () => {
    fake.on("GET", ANALYTICS, { kind: "error", status: 404 });
    expect(await pinterestInsights.readPostMetrics(postCtx())).toEqual({ kind: "page", entries: [{ externalId: "pin-1", kind: "gone" }] });
  });

  it("5xx -> retryable_error", async () => {
    fake.on("GET", ANALYTICS, { kind: "http", status: 500 });
    expect(await pinterestInsights.readPostMetrics(postCtx())).toMatchObject({ kind: "retryable_error" });
  });

  it("a network failure -> retryable_error", async () => {
    fake.on("GET", ANALYTICS, { kind: "pre_send_failure" });
    expect(await pinterestInsights.readPostMetrics(postCtx())).toMatchObject({ kind: "retryable_error" });
  });

  it("other 4xx -> fatal_error", async () => {
    fake.on("GET", ANALYTICS, { kind: "error", status: 400, message: "Bad request" });
    expect(await pinterestInsights.readPostMetrics(postCtx())).toMatchObject({ kind: "fatal_error" });
  });

  it("a token planted in Pinterest's error text never appears in the returned string", async () => {
    fake.on("GET", ANALYTICS, { kind: "error", status: 400, message: `leaked ${TOKEN}` });
    fake.secrets(TOKEN);
    const r = await pinterestInsights.readPostMetrics(postCtx());
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("unreadable credentials -> credentials_invalid, with no call made", async () => {
    const r = await pinterestInsights.readPostMetrics({ ...postCtx(), account: { ...postCtx().account, credentials: null } });
    expect(r).toMatchObject({ kind: "credentials_invalid" });
    expect(fake.requests).toHaveLength(0);
  });
});

describe("pinterestInsights.readAccountMetrics", () => {
  it("maps the documented shape via GET /v5/user_account, requiring no extra scope (FR-028, FR-029)", async () => {
    fake.on("GET", USER_ACCOUNT, { kind: "ok", body: { id: "pinterest-user-1", follower_count: 120, monthly_views: 5000 } });
    const r = await pinterestInsights.readAccountMetrics(accountCtx());
    expect(r).toEqual({ kind: "page", metrics: { pinterest_follower_count: 120, monthly_views: 5000 } });
  });

  it("omits a key the response did not report", async () => {
    fake.on("GET", USER_ACCOUNT, { kind: "ok", body: { id: "pinterest-user-1", follower_count: 120 } });
    const r = await pinterestInsights.readAccountMetrics(accountCtx());
    expect(r).toEqual({ kind: "page", metrics: { pinterest_follower_count: 120 } });
  });

  it("an account whose granted_scopes is null still gets account numbers (FR-035) — accountScopes is empty, so no scope check blocks it", async () => {
    fake.on("GET", USER_ACCOUNT, { kind: "ok", body: { id: "pinterest-user-1", follower_count: 1, monthly_views: 2 } });
    expect(pinterestInsights.declaration.accountScopes).toEqual([]);
    const r = await pinterestInsights.readAccountMetrics(accountCtx());
    expect(r).toEqual({ kind: "page", metrics: { pinterest_follower_count: 1, monthly_views: 2 } });
  });

  it("401 -> credentials_invalid", async () => {
    fake.on("GET", USER_ACCOUNT, { kind: "error", status: 401 });
    expect(await pinterestInsights.readAccountMetrics(accountCtx())).toMatchObject({ kind: "credentials_invalid" });
  });

  it("other 4xx -> fatal_error", async () => {
    fake.on("GET", USER_ACCOUNT, { kind: "error", status: 400 });
    expect(await pinterestInsights.readAccountMetrics(accountCtx())).toMatchObject({ kind: "fatal_error" });
  });
});
