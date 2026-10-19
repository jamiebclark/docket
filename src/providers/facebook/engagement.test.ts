import { describe, expect, it } from "vitest";
import { facebookCommentSurface, facebookEngagement } from "./engagement";

describe("facebookCommentSurface.mapAuthor", () => {
  it("maps a from: {name, id} fragment", () => {
    expect(facebookCommentSurface.mapAuthor({ from: { name: "Ada", id: "u1" } })).toEqual({
      displayName: "Ada",
      handle: null,
      externalId: "u1",
      url: null,
      identityStable: true,
    });
  });

  it("maps a from-absent fragment to a fully-null, unstable author", () => {
    expect(facebookCommentSurface.mapAuthor({})).toEqual({
      displayName: null,
      handle: null,
      externalId: null,
      url: null,
      identityStable: false,
    });
  });
});

describe("facebookCommentSurface.isSelf", () => {
  it("is true when from.id equals the Page's externalId", () => {
    expect(facebookCommentSurface.isSelf({ from: { id: "page-1" } }, { externalId: "page-1", selfUsername: null })).toBe(true);
  });

  it("is false when from.id differs", () => {
    expect(facebookCommentSurface.isSelf({ from: { id: "other" } }, { externalId: "page-1", selfUsername: null })).toBe(false);
  });
});

describe("facebookEngagement.declaration", () => {
  it("matches contracts/meta-comment-surface.md §3 verbatim", () => {
    expect(facebookEngagement.declaration).toEqual({
      reads: ["comment"],
      canReply: false,
      readScopes: ["pages_read_engagement", "pages_read_user_content"],
      missingReadScopes: {
        reason:
          "A Facebook Page needs the pages_read_user_content permission before Docket can read the "
          + "comments people leave on its posts.",
        docsPath: "meta-setup#engagement",
      },
    });
  });
});
