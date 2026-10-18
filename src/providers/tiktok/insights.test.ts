import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeTikTok, type FakeTikTok } from "../../../tests/helpers/fake-tiktok";
import type { AccountMetricsReadContext, PostMetricsReadContext } from "../types";
import type { TikTokCredentials } from "./credentials";
import { tiktokInsights } from "./insights";

const VIDEO_QUERY = "/v2/video/query/";
const USER_INFO = "/v2/user/info/";
const now = new Date("2026-01-01T12:00:00Z");
const TOKEN = "ACCESS-TOKEN-1";

const credentials: TikTokCredentials = {
  v: 1,
  accessToken: TOKEN,
  refreshToken: "REFRESH-TOKEN-1",
  accessExpiresAt: now.getTime() + 86_400_000,
  refreshIssuedAt: now.getTime(),
  refreshExpiresAt: now.getTime() + 31_536_000_000,
  refreshExpiryEstimated: false,
  openId: "open-id-1",
};

let fake: FakeTikTok;
beforeEach(() => {
  fake = createFakeTikTok().install();
});
afterEach(() => fake.uninstall());

const postCtx = (posts: readonly { externalId: string }[] = [{ externalId: "v1" }]): PostMetricsReadContext<unknown> => ({
  account: { id: "a1", externalId: "open-id-1", displayName: "Ada", settings: {}, credentials },
  posts,
  now,
  signal: new AbortController().signal,
});

const accountCtx = (): AccountMetricsReadContext<unknown> => ({
  account: { id: "a1", externalId: "open-id-1", displayName: "Ada", settings: {}, credentials },
  now,
  signal: new AbortController().signal,
});

const ok = (body: unknown, status = 200) => ({ kind: "ok" as const, body, status });
const error = (code: string, status = 200, message = "") => ({ kind: "error" as const, code, message, status });

describe("tiktokInsights.declaration", () => {
  it("declares the post, account and shared fields of contracts/platform-readers-082.md §1", () => {
    expect(tiktokInsights.declaration.post).toEqual([
      { key: "tiktok_like_count", label: "Likes" },
      { key: "comment_count", label: "Comments" },
      { key: "share_count", label: "Shares" },
      { key: "view_count", label: "Views" },
    ]);
    expect(tiktokInsights.declaration.account).toEqual([
      { key: "tiktok_follower_count", label: "Followers" },
      { key: "likes_count", label: "Likes" },
      { key: "video_count", label: "Videos" },
    ]);
    expect(tiktokInsights.declaration.maxPostsPerRead).toBe(20);
    expect(tiktokInsights.declaration.postIdSource).toBe("publicPostId");
    expect(tiktokInsights.declaration.postScopes).toEqual(["video.list"]);
    expect(tiktokInsights.declaration.accountScopes).toEqual(["user.info.stats"]);
  });

  it("declares a 600/60s read budget, PARTLY CONFIRMED per-app token (research §1)", () => {
    expect(tiktokInsights.declaration.readBudget).toEqual({ count: 600, windowSeconds: 60 });
  });
});

describe("tiktokInsights.readPostMetrics", () => {
  it("maps a happy page of the documented shape, requesting exactly the declared fields (contracts/platform-readers-082.md §1, §4)", async () => {
    fake.on("POST", VIDEO_QUERY, ok({ data: { videos: [{ id: "v1", like_count: 10, comment_count: 2, share_count: 1, view_count: 100 }] }, error: { code: "ok", message: "", log_id: "l1" } }));
    const r = await tiktokInsights.readPostMetrics(postCtx());
    expect(r).toEqual({ kind: "page", entries: [{ externalId: "v1", kind: "metrics", metrics: { tiktok_like_count: 10, comment_count: 2, share_count: 1, view_count: 100 } }] });
    const req = fake.requests[0]!;
    expect(req.path).toBe(VIDEO_QUERY);
    expect(req.query.fields).toBe("like_count,comment_count,share_count,view_count,id");
    expect(req.fields).toEqual({ filters: { video_ids: ["v1"] } });
  });

  it("omits a key the response did not report, instead of storing a zero (FR-024, §4)", async () => {
    fake.on("POST", VIDEO_QUERY, ok({ data: { videos: [{ id: "v1", like_count: 5 }] }, error: { code: "ok" } }));
    const r = await tiktokInsights.readPostMetrics(postCtx());
    expect(r).toEqual({ kind: "page", entries: [{ externalId: "v1", kind: "metrics", metrics: { tiktok_like_count: 5 } }] });
  });

  it("an id the response omits a videos entry for becomes one unqueryable entry naming both possibilities (FR-022)", async () => {
    fake.on("POST", VIDEO_QUERY, ok({ data: { videos: [] }, error: { code: "ok" } }));
    const r = await tiktokInsights.readPostMetrics(postCtx([{ externalId: "missing-1" }]));
    expect(r).toEqual({
      kind: "page",
      entries: [
        {
          externalId: "missing-1",
          kind: "unqueryable",
          reason: "TikTok did not return this post for this account; it may have been deleted, or the stored id may not be a video id.",
        },
      ],
    });
  });

  it("a mix of returned and omitted ids produces one metrics entry and one unqueryable entry, nothing invented", async () => {
    fake.on("POST", VIDEO_QUERY, ok({ data: { videos: [{ id: "v1", view_count: 9 }] }, error: { code: "ok" } }));
    const r = await tiktokInsights.readPostMetrics(postCtx([{ externalId: "v1" }, { externalId: "v2" }]));
    expect(r).toEqual({
      kind: "page",
      entries: [
        { externalId: "v1", kind: "metrics", metrics: { view_count: 9 } },
        { externalId: "v2", kind: "unqueryable", reason: expect.stringContaining("did not return this post") },
      ],
    });
  });

  it("expired access token -> credentials_invalid", async () => {
    fake.on("POST", VIDEO_QUERY, error("access_token_invalid", 401));
    expect(await tiktokInsights.readPostMetrics(postCtx())).toMatchObject({ kind: "credentials_invalid" });
  });

  it("a 401 with no code also -> credentials_invalid", async () => {
    fake.on("POST", VIDEO_QUERY, { kind: "http", status: 401, body: "" });
    expect(await tiktokInsights.readPostMetrics(postCtx())).toMatchObject({ kind: "credentials_invalid" });
  });

  it("rate_limit_exceeded -> rate_limited with retryAt", async () => {
    fake.on("POST", VIDEO_QUERY, error("rate_limit_exceeded", 429));
    const r = await tiktokInsights.readPostMetrics(postCtx());
    expect(r).toMatchObject({ kind: "rate_limited" });
    if (r.kind === "rate_limited") expect(r.retryAt).toEqual(new Date(now.getTime() + 60_000));
  });

  it("spam_risk_too_many_posts (cap) -> retryable_error", async () => {
    fake.on("POST", VIDEO_QUERY, error("spam_risk_too_many_posts", 403));
    expect(await tiktokInsights.readPostMetrics(postCtx())).toMatchObject({ kind: "retryable_error" });
  });

  it("a network failure -> retryable_error", async () => {
    fake.on("POST", VIDEO_QUERY, { kind: "pre_send_failure" });
    expect(await tiktokInsights.readPostMetrics(postCtx())).toMatchObject({ kind: "retryable_error" });
  });

  it("a 5xx -> retryable_error", async () => {
    fake.on("POST", VIDEO_QUERY, { kind: "http", status: 500, body: "" });
    expect(await tiktokInsights.readPostMetrics(postCtx())).toMatchObject({ kind: "retryable_error" });
  });

  it("refused with scope_not_authorized -> unavailable naming video.list (contracts/platform-readers-082.md §1)", async () => {
    fake.on("POST", VIDEO_QUERY, error("scope_not_authorized", 403));
    const r = await tiktokInsights.readPostMetrics(postCtx());
    expect(r).toEqual({
      kind: "unavailable",
      reason: "A TikTok account needs the video.list permission before Docket can read its post numbers.",
      docsPath: "tiktok-setup#insights",
    });
  });

  it("any other refused -> fatal_error", async () => {
    fake.on("POST", VIDEO_QUERY, error("invalid_param", 400));
    expect(await tiktokInsights.readPostMetrics(postCtx())).toMatchObject({ kind: "fatal_error" });
  });

  it("a token planted in TikTok's error text never appears in the returned string", async () => {
    fake.on("POST", VIDEO_QUERY, error("invalid_param", 400, `leaked ${TOKEN}`));
    const r = await tiktokInsights.readPostMetrics(postCtx());
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("unreadable credentials -> credentials_invalid, with no call made", async () => {
    const r = await tiktokInsights.readPostMetrics({ ...postCtx(), account: { ...postCtx().account, credentials: null } });
    expect(r).toMatchObject({ kind: "credentials_invalid" });
    expect(fake.requests).toHaveLength(0);
  });
});

describe("tiktokInsights.readAccountMetrics", () => {
  it("maps the documented shape, requesting exactly the declared fields", async () => {
    fake.on("GET", USER_INFO, ok({ data: { user: { follower_count: 50, likes_count: 200, video_count: 12 } }, error: { code: "ok" } }));
    const r = await tiktokInsights.readAccountMetrics(accountCtx());
    expect(r).toEqual({ kind: "page", metrics: { tiktok_follower_count: 50, likes_count: 200, video_count: 12 } });
    expect(fake.requests[0]!.query.fields).toBe("follower_count,likes_count,video_count");
  });

  it("omits a key the response did not report", async () => {
    fake.on("GET", USER_INFO, ok({ data: { user: { follower_count: 50 } }, error: { code: "ok" } }));
    const r = await tiktokInsights.readAccountMetrics(accountCtx());
    expect(r).toEqual({ kind: "page", metrics: { tiktok_follower_count: 50 } });
  });

  it("rate_limit_exceeded -> rate_limited", async () => {
    fake.on("GET", USER_INFO, error("rate_limit_exceeded", 429));
    expect(await tiktokInsights.readAccountMetrics(accountCtx())).toMatchObject({ kind: "rate_limited" });
  });

  it("scope_not_authorized -> unavailable naming user.info.stats", async () => {
    fake.on("GET", USER_INFO, error("scope_not_authorized", 403));
    const r = await tiktokInsights.readAccountMetrics(accountCtx());
    expect(r).toEqual({
      kind: "unavailable",
      reason: "A TikTok account needs the user.info.stats permission before Docket can read its account numbers.",
      docsPath: "tiktok-setup#insights",
    });
  });

  it("any other refused -> fatal_error", async () => {
    fake.on("GET", USER_INFO, error("invalid_param", 400));
    expect(await tiktokInsights.readAccountMetrics(accountCtx())).toMatchObject({ kind: "fatal_error" });
  });
});
