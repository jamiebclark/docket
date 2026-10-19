import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePds, mintJwt, type FakePds } from "../../../tests/helpers/fake-pds";
import type { AccountMetricsReadContext, PostMetricsReadContext } from "../types";
import { blueskyInsights } from "./insights";
import type { BlueskySettings } from "./settings";

const GET_POSTS = "/xrpc/app.bsky.feed.getPosts";
const GET_PROFILE = "/xrpc/app.bsky.actor.getProfile";
const DID = "did:plc:brand";
const ACCESS = mintJwt(new Date("2026-01-01T01:00:00Z"));
const now = new Date("2026-01-01T00:00:00Z");

function postCtx(over: Partial<PostMetricsReadContext<BlueskySettings>> = {}): PostMetricsReadContext<BlueskySettings> {
  return {
    account: { id: "a1", externalId: DID, displayName: "brand.bsky.social", settings: { pdsUrl: "https://pds.test" }, credentials: { accessJwt: ACCESS, refreshJwt: "r", did: DID, handle: "brand.bsky.social" } },
    posts: [{ externalId: "at://did:plc:brand/app.bsky.feed.post/3k1" }],
    now,
    signal: new AbortController().signal,
    ...over,
  };
}

function accountCtx(over: Partial<AccountMetricsReadContext<BlueskySettings>> = {}): AccountMetricsReadContext<BlueskySettings> {
  return {
    account: { id: "a1", externalId: DID, displayName: "brand.bsky.social", settings: { pdsUrl: "https://pds.test" }, credentials: { accessJwt: ACCESS, refreshJwt: "r", did: DID, handle: "brand.bsky.social" } },
    now,
    signal: new AbortController().signal,
    ...over,
  };
}

let pds: FakePds;
beforeEach(() => {
  pds = createFakePds();
  vi.stubGlobal("fetch", pds.fetch);
});
afterEach(() => vi.unstubAllGlobals());

describe("blueskyInsights.declaration", () => {
  it("declares the post keys, account keys, labels and maxPostsPerRead:25", () => {
    expect(blueskyInsights.declaration.post).toEqual([
      { key: "likeCount", label: "Likes", shape: { kind: "cumulative" } },
      { key: "repostCount", label: "Reposts", shape: { kind: "cumulative" } },
      { key: "replyCount", label: "Replies", shape: { kind: "cumulative" } },
      { key: "quoteCount", label: "Quotes", shape: { kind: "cumulative" } },
    ]);
    expect(blueskyInsights.declaration.account).toEqual([
      { key: "followersCount", label: "Followers", shape: { kind: "cumulative" } },
      { key: "followsCount", label: "Following", shape: { kind: "cumulative" } },
      { key: "postsCount", label: "Posts", shape: { kind: "cumulative" } },
    ]);
    expect(blueskyInsights.declaration.maxPostsPerRead).toBe(25);
  });

  it("declares no view, impression or reach key for posts or accounts", () => {
    const allKeys = [...blueskyInsights.declaration.post, ...blueskyInsights.declaration.account].map((k) => k.key.toLowerCase());
    for (const banned of ["view", "impression", "reach"]) {
      expect(allKeys.some((k) => k.includes(banned))).toBe(false);
    }
  });
});

describe("blueskyInsights.readPostMetrics", () => {
  it("returns only the contained count, not three zeroes", async () => {
    pds.route("GET", GET_POSTS, { json: { posts: [{ uri: "at://did:plc:brand/app.bsky.feed.post/3k1", cid: "bafyreib2rxk3rybk3aobmv5cjuql3bm2twh4jo5uxgf5kpqcsgzmq2vz2m", author: { did: DID, handle: "brand.bsky.social" }, record: {}, indexedAt: now.toISOString(), likeCount: 2 }] } });
    const result = await blueskyInsights.readPostMetrics(postCtx());
    expect(result.kind).toBe("page");
    if (result.kind !== "page") throw new Error("unreachable");
    expect(result.entries).toEqual([{ externalId: "at://did:plc:brand/app.bsky.feed.post/3k1", kind: "metrics", metrics: { likeCount: 2 } }]);
  });

  it("maps a requested at-URI absent from the response to gone, for that id alone", async () => {
    pds.route("GET", GET_POSTS, {
      json: {
        posts: [{ uri: "at://did:plc:brand/app.bsky.feed.post/3k1", cid: "bafyreib2rxk3rybk3aobmv5cjuql3bm2twh4jo5uxgf5kpqcsgzmq2vz2m", author: { did: DID, handle: "brand.bsky.social" }, record: {}, indexedAt: now.toISOString(), likeCount: 1 }],
      },
    });
    const result = await blueskyInsights.readPostMetrics(
      postCtx({ posts: [{ externalId: "at://did:plc:brand/app.bsky.feed.post/3k1" }, { externalId: "at://did:plc:brand/app.bsky.feed.post/gone" }] }),
    );
    expect(result.kind).toBe("page");
    if (result.kind !== "page") throw new Error("unreachable");
    expect(result.entries).toEqual([
      { externalId: "at://did:plc:brand/app.bsky.feed.post/3k1", kind: "metrics", metrics: { likeCount: 1 } },
      { externalId: "at://did:plc:brand/app.bsky.feed.post/gone", kind: "gone" },
    ]);
  });

  it("makes one getPosts call carrying all requested uris", async () => {
    const uris = ["at://did:plc:brand/app.bsky.feed.post/1", "at://did:plc:brand/app.bsky.feed.post/2", "at://did:plc:brand/app.bsky.feed.post/3"];
    pds.route("GET", GET_POSTS, {
      json: { posts: uris.map((uri) => ({ uri, cid: "bafyreib2rxk3rybk3aobmv5cjuql3bm2twh4jo5uxgf5kpqcsgzmq2vz2m", author: { did: DID, handle: "brand.bsky.social" }, record: {}, indexedAt: now.toISOString() })) },
    });
    await blueskyInsights.readPostMetrics(postCtx({ posts: uris.map((externalId) => ({ externalId })) }));
    const calls = pds.callsTo("GET", GET_POSTS);
    expect(calls).toHaveLength(1);
    for (const uri of uris) expect(calls[0]!.url).toContain(encodeURIComponent(uri));
  });

  it("rate_limited: a 429 with a reset header carries retryAt", async () => {
    pds.route("GET", GET_POSTS, { status: 429, headers: { "retry-after": "30" }, json: { error: "RateLimitExceeded" } });
    const result = await blueskyInsights.readPostMetrics(postCtx());
    expect(result.kind).toBe("rate_limited");
    if (result.kind !== "rate_limited") throw new Error("unreachable");
    expect(result.retryAt).toBeInstanceOf(Date);
  });

  it("credentials_invalid: a 401", async () => {
    pds.route("GET", GET_POSTS, { status: 401, json: { error: "ExpiredToken" } });
    const result = await blueskyInsights.readPostMetrics(postCtx());
    expect(result.kind).toBe("credentials_invalid");
  });

  it("retryable_error: a 503", async () => {
    pds.route("GET", GET_POSTS, { status: 503, json: { error: "InternalServerError" } });
    const result = await blueskyInsights.readPostMetrics(postCtx());
    expect(result.kind).toBe("retryable_error");
  });

  it("retryable_error: ENOTFOUND (unreachable host)", async () => {
    pds.route("GET", GET_POSTS, { mode: "pre-send-failure", code: "ENOTFOUND" });
    const result = await blueskyInsights.readPostMetrics(postCtx());
    expect(result.kind).toBe("retryable_error");
  });

  it("fatal_error: a 403", async () => {
    pds.route("GET", GET_POSTS, { status: 403, json: { error: "Forbidden" } });
    const result = await blueskyInsights.readPostMetrics(postCtx());
    expect(result.kind).toBe("fatal_error");
  });

  it("an abort maps rather than escaping", async () => {
    pds.route("GET", GET_POSTS, { mode: "hang" });
    const controller = new AbortController();
    const resultPromise = blueskyInsights.readPostMetrics(postCtx({ signal: controller.signal }));
    controller.abort();
    const result = await resultPromise;
    expect(["retryable_error", "fatal_error"]).toContain(result.kind);
  });

  it("a malformed body maps rather than escaping", async () => {
    pds.route("GET", GET_POSTS, { text: "not json", headers: { "content-type": "application/json" } });
    const result = await blueskyInsights.readPostMetrics(postCtx());
    expect(["retryable_error", "fatal_error"]).toContain(result.kind);
  });

  it("unreadable stored credentials never call the platform", async () => {
    const result = await blueskyInsights.readPostMetrics(postCtx({ account: { id: "a1", externalId: DID, displayName: "brand", settings: { pdsUrl: "https://pds.test" }, credentials: {} } }));
    expect(result.kind).toBe("credentials_invalid");
    expect(pds.callsTo("GET", GET_POSTS)).toHaveLength(0);
  });

  it("no result message carries the access JWT, the refresh JWT or an app password", async () => {
    pds.route("GET", GET_POSTS, { status: 403, json: { error: "Forbidden" } });
    const result = await blueskyInsights.readPostMetrics(
      postCtx({ account: { id: "a1", externalId: DID, displayName: "brand", settings: { pdsUrl: "https://pds.test" }, credentials: { accessJwt: ACCESS, refreshJwt: "refresh-secret", did: DID, handle: "brand.bsky.social", appPassword: "app-pw-secret" } } }),
    );
    const text = JSON.stringify(result);
    expect(text).not.toContain(ACCESS);
    expect(text).not.toContain("refresh-secret");
    expect(text).not.toContain("app-pw-secret");
  });
});

describe("blueskyInsights.readAccountMetrics", () => {
  it("returns only the counts the profile contained", async () => {
    pds.route("GET", GET_PROFILE, { json: { did: DID, handle: "brand.bsky.social", followersCount: 42 } });
    const result = await blueskyInsights.readAccountMetrics(accountCtx());
    expect(result).toEqual({ kind: "page", metrics: { followersCount: 42 } });
  });

  it("credentials_invalid: a 401", async () => {
    pds.route("GET", GET_PROFILE, { status: 401, json: { error: "ExpiredToken" } });
    const result = await blueskyInsights.readAccountMetrics(accountCtx());
    expect(result.kind).toBe("credentials_invalid");
  });

  it("fatal_error: a 403", async () => {
    pds.route("GET", GET_PROFILE, { status: 403, json: { error: "Forbidden" } });
    const result = await blueskyInsights.readAccountMetrics(accountCtx());
    expect(result.kind).toBe("fatal_error");
  });
});
