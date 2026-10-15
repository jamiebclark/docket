import { describe, expect, it } from "vitest";
import { mapBlueskyNotification } from "./engagement-map";

const AUTHOR = { did: "did:plc:ada", handle: "ada.bsky.social", displayName: "Ada" };

describe("mapBlueskyNotification (contracts/provider-engagement.md)", () => {
  it("maps a reply, carrying cid and root into provider_data", () => {
    const draft = mapBlueskyNotification({
      uri: "at://did:plc:brand/app.bsky.feed.post/3k1",
      cid: "cid-1",
      reason: "reply",
      reasonSubject: "at://did:plc:brand/app.bsky.feed.post/3k0",
      author: AUTHOR,
      record: { text: "Nice post!", createdAt: "2026-10-01T12:00:00.000Z", reply: { root: { uri: "at://root", cid: "cid-root" }, parent: { uri: "at://parent", cid: "cid-parent" } } },
      indexedAt: "2026-10-01T12:00:05.000Z",
    });
    expect(draft).toMatchObject({
      kind: "reply",
      externalId: "at://did:plc:brand/app.bsky.feed.post/3k1",
      text: "Nice post!",
      saidAt: new Date("2026-10-01T12:00:00.000Z"),
      parentExternalId: "at://did:plc:brand/app.bsky.feed.post/3k0",
      author: { displayName: "Ada", handle: "ada.bsky.social", externalId: "did:plc:ada", identityStable: true },
      data: { cid: "cid-1", root: { uri: "at://root", cid: "cid-root" } },
    });
  });

  it("maps a mention with no reply record, never inventing an author field", () => {
    const draft = mapBlueskyNotification({
      uri: "at://did:plc:brand/app.bsky.feed.post/3k2",
      cid: "cid-2",
      reason: "mention",
      author: { did: "did:plc:bea", handle: "bea.bsky.social" },
      record: { text: "@brand hi", createdAt: "2026-10-01T13:00:00.000Z" },
      indexedAt: "2026-10-01T13:00:05.000Z",
    });
    expect(draft.kind).toBe("mention");
    expect(draft.author.displayName).toBeNull();
    expect(draft.parentExternalId).toBeNull();
    expect(draft.data).toEqual({ cid: "cid-2" });
  });

  it("falls back to indexedAt and empty text for an unreadable record, never throwing", () => {
    const draft = mapBlueskyNotification({
      uri: "at://x",
      cid: "cid-3",
      reason: "reply",
      author: AUTHOR,
      record: "not-an-object",
      indexedAt: "2026-10-01T14:00:00.000Z",
    });
    expect(draft.text).toBe("");
    expect(draft.saidAt).toEqual(new Date("2026-10-01T14:00:00.000Z"));
  });
});
