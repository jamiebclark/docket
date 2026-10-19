import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeGraph, type FakeGraph } from "../../../tests/helpers/fake-graph";
import { instagramCommentSurface, instagramEngagement } from "./engagement";

describe("instagramCommentSurface.mapAuthor", () => {
  it("maps a username-only fragment", () => {
    expect(instagramCommentSurface.mapAuthor({ username: "ada" })).toEqual({
      displayName: null,
      handle: "ada",
      externalId: null,
      url: null,
      identityStable: false,
    });
  });

  it("maps a username + user.id fragment (owned-comment case) without sourcing externalId from user", () => {
    expect(instagramCommentSurface.mapAuthor({ username: "ada", user: { id: "u1" } })).toEqual({
      displayName: null,
      handle: "ada",
      externalId: null,
      url: null,
      identityStable: false,
    });
  });
});

describe("instagramCommentSurface.isSelf", () => {
  it("is true on a matching username", () => {
    expect(instagramCommentSurface.isSelf({ username: "brand" }, { externalId: "ig-1", selfUsername: "brand" })).toBe(true);
  });

  it("is true on a matching user.id", () => {
    expect(instagramCommentSurface.isSelf({ user: { id: "ig-1" } }, { externalId: "ig-1", selfUsername: "brand" })).toBe(true);
  });

  it("is false when neither matches", () => {
    expect(instagramCommentSurface.isSelf({ username: "other", user: { id: "other-id" } }, { externalId: "ig-1", selfUsername: "brand" })).toBe(false);
  });
});

describe("instagramCommentSurface.prefetchSelf", () => {
  let fake: FakeGraph;

  beforeEach(() => {
    fake = createFakeGraph().install();
  });

  afterEach(() => {
    fake.uninstall();
  });

  it("returns the account's username on a scripted success", async () => {
    fake.on("GET", "/v26.0/1001", { kind: "ok", body: { username: "brand" } });
    const result = await instagramCommentSurface.prefetchSelf!({
      accountExternalId: "1001",
      token: "tok",
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ kind: "ok", selfUsername: "brand" });
  });

  it("maps a scripted failure through to a non-ok outcome, never a partial read", async () => {
    fake.on("GET", "/v26.0/1001", { kind: "graph_error", code: 190, message: "Invalid token" });
    const result = await instagramCommentSurface.prefetchSelf!({
      accountExternalId: "1001",
      token: "tok",
      signal: new AbortController().signal,
    });
    expect(result.kind).not.toBe("ok");
  });
});

describe("instagramEngagement.declaration", () => {
  it("matches contracts/meta-comment-surface.md §4 verbatim", () => {
    expect(instagramEngagement.declaration).toEqual({
      reads: ["comment"],
      canReply: false,
      readScopes: ["instagram_basic", "instagram_manage_comments", "pages_read_engagement"],
      missingReadScopes: {
        reason:
          "This Instagram account needs the instagram_manage_comments permission before Docket can read "
          + "the comments people leave on its posts. Reconnect the account to grant it.",
        docsPath: "meta-setup#engagement",
      },
    });
  });
});
