import { describe, expect, it } from "vitest";
import { mapMetaComment, type MetaCommentSurface, type MetaSelfIdentity } from "./engagement-map";

/** contracts/meta-comment-surface.md §3. */
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
    const displayName = typeof from?.name === "string" && from.name !== "" ? from.name : null;
    const externalId = typeof from?.id === "string" && from.id !== "" ? from.id : null;
    return { displayName, handle: null, externalId, url: null, identityStable: externalId !== null };
  },
  isSelf(comment, identity) {
    const from = comment.from as { id?: unknown } | undefined;
    return from?.id === identity.externalId;
  },
};

/** contracts/meta-comment-surface.md §4. */
const instagramSurface: MetaCommentSurface = {
  platform: "Instagram",
  ownPostsPath: (id) => `/${id}/media`,
  postTimeField: "timestamp",
  commentFields: ["id", "text", "timestamp", "username", "user{id}"],
  commentTextField: "text",
  commentTimeField: "timestamp",
  drainParams: {},
  prefetchSelf: async () => ({ kind: "ok", selfUsername: "brand_ig" }),
  mapAuthor() {
    return { displayName: null, handle: null, externalId: null, url: null, identityStable: false };
  },
  isSelf(comment, identity) {
    const username = comment.username;
    const user = comment.user as { id?: unknown } | undefined;
    return username === identity.selfUsername || user?.id === identity.externalId;
  },
};

const fbIdentity: MetaSelfIdentity = { externalId: "page-1", selfUsername: null };
const igIdentity: MetaSelfIdentity = { externalId: "ig-user-1", selfUsername: "brand_ig" };

describe("mapMetaComment", () => {
  it("maps a Facebook comment per contracts §3", () => {
    const draft = mapMetaComment(
      facebookSurface,
      { id: "comment-1", message: "Nice post!", created_time: "2026-01-01T00:00:00+0000", from: { name: "Jamie", id: "user-1" } },
      "post-1",
      fbIdentity,
    );
    expect(draft).toEqual({
      kind: "comment",
      externalId: "comment-1",
      text: "Nice post!",
      author: { displayName: "Jamie", handle: null, externalId: "user-1", url: null, identityStable: true },
      saidAt: new Date("2026-01-01T00:00:00+0000"),
      parentExternalId: "post-1",
      data: {},
    });
  });

  it("maps a Facebook comment with no from field to a fully-null, unstable author", () => {
    const draft = mapMetaComment(facebookSurface, { id: "comment-2", message: "hi", created_time: "2026-01-01T00:00:00+0000" }, "post-1", fbIdentity);
    expect(draft?.author).toEqual({ displayName: null, handle: null, externalId: null, url: null, identityStable: false });
  });

  it("produces no draft for a Facebook comment whose from.id is the Page's own id", () => {
    const draft = mapMetaComment(facebookSurface, { id: "c", message: "m", created_time: "2026-01-01T00:00:00+0000", from: { id: "page-1" } }, "post-1", fbIdentity);
    expect(draft).toBeNull();
  });

  it("maps an Instagram comment per contracts §4", () => {
    const draft = mapMetaComment(instagramSurface, { id: "ig-comment-1", text: "love it", timestamp: "2026-01-02T00:00:00+0000", username: "someone" }, "media-1", igIdentity);
    expect(draft).toEqual({
      kind: "comment",
      externalId: "ig-comment-1",
      text: "love it",
      author: { displayName: null, handle: null, externalId: null, url: null, identityStable: false },
      saidAt: new Date("2026-01-02T00:00:00+0000"),
      parentExternalId: "media-1",
      data: {},
    });
  });

  it("produces no draft for an Instagram comment whose username equals the account's own identity", () => {
    const draft = mapMetaComment(instagramSurface, { id: "c", text: "t", timestamp: "2026-01-02T00:00:00+0000", username: "brand_ig" }, "media-1", igIdentity);
    expect(draft).toBeNull();
  });

  it("produces no draft for an Instagram comment whose user.id equals the account's own identity", () => {
    const draft = mapMetaComment(instagramSurface, { id: "c", text: "t", timestamp: "2026-01-02T00:00:00+0000", username: "someone_else", user: { id: "ig-user-1" } }, "media-1", igIdentity);
    expect(draft).toBeNull();
  });

  it("skips a comment with no usable id", () => {
    expect(mapMetaComment(facebookSurface, { message: "m", created_time: "2026-01-01T00:00:00+0000" }, "post-1", fbIdentity)).toBeNull();
    expect(mapMetaComment(facebookSurface, { id: "  ", message: "m", created_time: "2026-01-01T00:00:00+0000" }, "post-1", fbIdentity)).toBeNull();
  });

  it("skips a comment with an unparseable time, never dating it now", () => {
    expect(mapMetaComment(facebookSurface, { id: "c", message: "m", created_time: "not a date" }, "post-1", fbIdentity)).toBeNull();
    expect(mapMetaComment(facebookSurface, { id: "c", message: "m" }, "post-1", fbIdentity)).toBeNull();
  });

  it("truncates text at 10,000 characters and sets textTruncated", () => {
    const longText = "a".repeat(10_050);
    const draft = mapMetaComment(facebookSurface, { id: "c", message: longText, created_time: "2026-01-01T00:00:00+0000" }, "post-1", fbIdentity);
    expect(draft?.text.length).toBe(10_000);
    expect(draft?.textTruncated).toBe(true);
  });

  it("never truncates text at exactly 10,000 characters", () => {
    const text = "a".repeat(10_000);
    const draft = mapMetaComment(facebookSurface, { id: "c", message: text, created_time: "2026-01-01T00:00:00+0000" }, "post-1", fbIdentity);
    expect(draft?.textTruncated).toBeUndefined();
  });
});
