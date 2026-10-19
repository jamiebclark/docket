import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeGraph, type FakeGraph } from "../../../tests/helpers/fake-graph";
import type { EngagementReadContext } from "../types";
import { resetUsageBackoffs } from "./usage";
import { metaEngagementRead } from "./engagement-sweep";
import type { MetaCommentSurface } from "./engagement-map";
import { DEFAULT_GRAPH_BASE, graphRequest } from "./graph";

const TOKEN = "page-token";

/** A minimal Facebook-shaped surface, per contracts/meta-comment-surface.md §3. */
const facebookSurface: MetaCommentSurface = {
  platform: "Facebook",
  ownPostsPath: (id) => `/${id}/posts`,
  postTimeField: "created_time",
  commentFields: ["id", "message", "created_time", "from{name,id}"],
  commentTextField: "message",
  commentTimeField: "created_time",
  drainParams: { order: "reverse_chronological", filter: "toplevel" },
  prefetchSelf: null,
  mapAuthor(comment) {
    const from = comment.from as { name?: unknown; id?: unknown } | undefined;
    return {
      displayName: typeof from?.name === "string" ? from.name : null,
      handle: null,
      externalId: typeof from?.id === "string" ? from.id : null,
      url: null,
      identityStable: typeof from?.id === "string",
    };
  },
  isSelf(comment, identity) {
    const from = comment.from as { id?: unknown } | undefined;
    return from?.id === identity.externalId;
  },
};

function baseCtx(overrides: Partial<EngagementReadContext<unknown>> = {}): EngagementReadContext<unknown> {
  return {
    account: { id: "acct-1", externalId: "1001", displayName: "Page", settings: {}, credentials: { pageToken: TOKEN } },
    cursor: null,
    providerState: {},
    direction: "newest",
    limit: 50,
    now: new Date("2026-10-19T00:00:00Z"),
    signal: new AbortController().signal,
    ...overrides,
  };
}

let fake: FakeGraph;

beforeEach(() => {
  fake = createFakeGraph().install();
  resetUsageBackoffs();
});

afterEach(() => {
  fake.uninstall();
});

describe("metaEngagementRead — fresh step", () => {
  it("emits the expected drafts for one page of posts with inline comments", async () => {
    fake.on("GET", "/v26.0/1001/posts", {
      kind: "ok",
      body: {
        data: [
          {
            id: "post-1",
            created_time: "2026-10-01T00:00:00+0000",
            comments: {
              data: [{ id: "c1", message: "hello", created_time: "2026-10-01T01:00:00+0000", from: { name: "Ada", id: "u1" } }],
            },
          },
        ],
      },
    });

    const result = await metaEngagementRead(facebookSurface, baseCtx());
    if (result.kind !== "page") throw new Error(`expected page, got ${result.kind}`);
    expect(result.items).toEqual([
      {
        kind: "comment",
        externalId: "c1",
        text: "hello",
        author: { displayName: "Ada", handle: null, externalId: "u1", url: null, identityStable: true },
        saidAt: new Date("2026-10-01T01:00:00+0000"),
        parentExternalId: "post-1",
        data: {},
      },
    ]);
    expect(result.exhausted).toBe(false);
    expect(result.cursor).toBeNull();
    expect((result.providerState as { lastStep?: string }).lastStep).toBe("fresh");
    expect(fake.requests).toHaveLength(1);
  });

  it("skips a comment at or below freshSince on a later fresh read (after the intervening catch-up step)", async () => {
    // The step chooser alternates fresh/catch-up (contracts §4.2 step 3), so the comment is seen
    // again by the catch-up step in between; only a *fresh* step applies the freshSince filter.
    fake.on("GET", "/v26.0/1001/posts", {
      kind: "ok",
      body: {
        data: [{ id: "post-1", created_time: "2026-10-01T00:00:00+0000", comments: { data: [{ id: "c1", message: "hello", created_time: "2026-10-01T01:00:00+0000", from: { id: "u1" } }] } }],
      },
    });
    const first = await metaEngagementRead(facebookSurface, baseCtx());
    if (first.kind !== "page") throw new Error("expected page");

    const second = await metaEngagementRead(facebookSurface, baseCtx({ providerState: first.providerState }));
    if (second.kind !== "page") throw new Error("expected page");

    const third = await metaEngagementRead(facebookSurface, baseCtx({ providerState: second.providerState }));
    if (third.kind !== "page") throw new Error("expected page");
    expect(third.items).toEqual([]);
  });

  it("emits only a comment strictly newer than freshSince on a later fresh read", async () => {
    const olderOnly = { data: [{ id: "post-1", created_time: "2026-10-01T00:00:00+0000", comments: { data: [{ id: "c1", message: "first", created_time: "2026-10-01T01:00:00+0000", from: { id: "u1" } }] } }] };
    const olderAndNewer = { data: [{ id: "post-1", created_time: "2026-10-01T00:00:00+0000", comments: { data: [{ id: "c1", message: "first", created_time: "2026-10-01T01:00:00+0000", from: { id: "u1" } }, { id: "c2", message: "second", created_time: "2026-10-01T02:00:00+0000", from: { id: "u1" } }] } }] };
    fake.on("GET", "/v26.0/1001/posts", [{ kind: "ok", body: olderOnly }, { kind: "ok", body: olderOnly }, { kind: "ok", body: olderAndNewer }]);

    const first = await metaEngagementRead(facebookSurface, baseCtx()); // fresh
    if (first.kind !== "page") throw new Error("expected page");
    const second = await metaEngagementRead(facebookSurface, baseCtx({ providerState: first.providerState })); // catch-up
    if (second.kind !== "page") throw new Error("expected page");
    const third = await metaEngagementRead(facebookSurface, baseCtx({ providerState: second.providerState })); // fresh again
    if (third.kind !== "page") throw new Error("expected page");
    expect(third.items.map((i) => i.externalId)).toEqual(["c2"]);
  });

  it("excludes the brand's own comment", async () => {
    fake.on("GET", "/v26.0/1001/posts", {
      kind: "ok",
      body: { data: [{ id: "post-1", created_time: "2026-10-01T00:00:00+0000", comments: { data: [{ id: "c1", message: "self", created_time: "2026-10-01T01:00:00+0000", from: { id: "1001" } }] } }] },
    });
    const result = await metaEngagementRead(facebookSurface, baseCtx());
    if (result.kind !== "page") throw new Error("expected page");
    expect(result.items).toEqual([]);
  });

  it("queues a busy post (full inline block, nested cursor) into pending", async () => {
    fake.on("GET", "/v26.0/1001/posts", {
      kind: "ok",
      body: {
        data: [
          {
            id: "post-1",
            created_time: "2026-10-01T00:00:00+0000",
            comments: {
              data: [{ id: "c1", message: "hi", created_time: "2026-10-01T01:00:00+0000", from: { id: "u1" } }],
              paging: { cursors: { after: "CURSOR1" } },
            },
          },
        ],
      },
    });
    const result = await metaEngagementRead(facebookSurface, baseCtx());
    if (result.kind !== "page") throw new Error("expected page");
    expect(result.providerState).toMatchObject({ pending: [{ postId: "post-1", after: "CURSOR1" }] });
  });
});

/** A minimal Instagram-shaped surface, per contracts/meta-comment-surface.md §4. */
const instagramSurface: MetaCommentSurface = {
  platform: "Instagram",
  ownPostsPath: (id) => `/${id}/media`,
  postTimeField: "timestamp",
  commentFields: ["id", "text", "timestamp", "username", "user{id}"],
  commentTextField: "text",
  commentTimeField: "timestamp",
  drainParams: {},
  async prefetchSelf({ accountExternalId, token, signal }) {
    const outcome = await graphRequest(
      { graphBase: DEFAULT_GRAPH_BASE, version: "v26.0" },
      { method: "GET", path: `/${accountExternalId}`, params: { fields: "username" }, token, signal },
    );
    if (outcome.kind !== "ok") return outcome;
    const body = outcome.body as { username?: unknown } | undefined;
    const selfUsername = typeof body?.username === "string" ? body.username : null;
    if (!selfUsername) return { kind: "unparseable", status: outcome.status, usage: outcome.usage };
    return { kind: "ok", selfUsername };
  },
  mapAuthor(comment) {
    const username = typeof comment.username === "string" && comment.username !== "" ? comment.username : null;
    return { displayName: null, handle: username, externalId: null, url: null, identityStable: false };
  },
  isSelf(comment, identity) {
    if (identity.selfUsername !== null && comment.username === identity.selfUsername) return true;
    const user = comment.user as { id?: unknown } | undefined;
    return typeof user?.id === "string" && user.id === identity.externalId;
  },
};

describe("metaEngagementRead — Instagram's prefetchSelf", () => {
  it("runs first and once; its result lands in the returned providerState", async () => {
    fake.on("GET", "/v26.0/1001", { kind: "ok", body: { username: "brand" } });
    fake.on("GET", "/v26.0/1001/media", { kind: "ok", body: { data: [] } });

    const result = await metaEngagementRead(instagramSurface, baseCtx());
    if (result.kind !== "page") throw new Error(`expected page, got ${result.kind}`);
    expect(result.providerState).toMatchObject({ selfUsername: "brand" });
    expect(fake.requests.filter((r) => r.path === "/v26.0/1001")).toHaveLength(1);

    // A second read, given the cached selfUsername, never re-runs the prefetch.
    fake.reset();
    fake.on("GET", "/v26.0/1001/media", { kind: "ok", body: { data: [] } });
    await metaEngagementRead(instagramSurface, baseCtx({ providerState: result.providerState }));
    expect(fake.requests.filter((r) => r.path === "/v26.0/1001")).toHaveLength(0);
  });

  it("returns the mapped outcome with zero comments emitted when prefetchSelf fails", async () => {
    fake.on("GET", "/v26.0/1001", { kind: "graph_error", code: 190, message: "Invalid token" });
    fake.on("GET", "/v26.0/1001/media", {
      kind: "ok",
      body: { data: [{ id: "post-1", timestamp: "2026-10-01T00:00:00+0000", comments: { data: [{ id: "c1", text: "hi", timestamp: "2026-10-01T01:00:00+0000", username: "someone" }] } }] },
    });

    const result = await metaEngagementRead(instagramSurface, baseCtx());
    expect(result.kind).not.toBe("page");
    expect(fake.requests.filter((r) => r.path === "/v26.0/1001/media")).toHaveLength(0);
  });

  it("drops nested replies present under a scripted replies key — only the top level is stored", async () => {
    fake.on("GET", "/v26.0/1001", { kind: "ok", body: { username: "brand" } });
    fake.on("GET", "/v26.0/1001/media", {
      kind: "ok",
      body: {
        data: [
          {
            id: "post-1",
            timestamp: "2026-10-01T00:00:00+0000",
            comments: {
              data: [
                {
                  id: "c1",
                  text: "top level",
                  timestamp: "2026-10-01T01:00:00+0000",
                  username: "someone",
                  replies: { data: [{ id: "r1", text: "a reply", timestamp: "2026-10-01T01:05:00+0000", username: "someone-else" }] },
                },
              ],
            },
          },
        ],
      },
    });

    const result = await metaEngagementRead(instagramSurface, baseCtx());
    if (result.kind !== "page") throw new Error(`expected page, got ${result.kind}`);
    expect(result.items.map((i) => i.externalId)).toEqual(["c1"]);
  });
});
