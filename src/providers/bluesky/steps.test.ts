import { describe, expect, it } from "vitest";
import { mentionHandles, stepForContent } from "./steps";

const blob = (n: number) => ({ $type: "blob" as const, ref: { $link: `cid${n}` }, mimeType: "image/jpeg", size: 10 });
const plain = (mediaCount = 0) => ({ text: "hello", mediaCount });
const withMention = (mediaCount = 0) => ({ text: "hi @a.bsky.social", mediaCount });

describe("stepForContent", () => {
  it("text-only publishes at once", () => {
    expect(stepForContent(null, plain())).toEqual({ name: "create_post", mayPublish: true });
  });
  it("resolves mentions first, once", () => {
    expect(stepForContent(null, withMention())).toEqual({ name: "resolve_mentions", mayPublish: false });
    expect(stepForContent({ v: 1, mentions: {} }, withMention())).toEqual({ name: "create_post", mayPublish: true });
  });
  it("uploads images in order, then publishes", () => {
    expect(stepForContent(null, plain(2))).toEqual({ name: "upload_image_1", mayPublish: false });
    expect(stepForContent({ v: 1, blobs: [blob(1)] }, plain(2))).toEqual({ name: "upload_image_2", mayPublish: false });
    expect(stepForContent({ v: 1, blobs: [blob(1), blob(2)] }, plain(2))).toEqual({ name: "create_post", mayPublish: true });
  });
  it("mentions come before images", () => {
    expect(stepForContent(null, withMention(1)).name).toBe("resolve_mentions");
    expect(stepForContent({ v: 1, mentions: { "a.bsky.social": "did:plc:a" } }, withMention(1)).name).toBe("upload_image_1");
  });
  it("reports invalid state without permission to publish", () => {
    expect(stepForContent({ v: 2 }, plain())).toEqual({ name: "invalid_state", mayPublish: false });
    expect(stepForContent("junk", plain())).toEqual({ name: "invalid_state", mayPublish: false });
  });
  it("is total on junk", () => {
    const junk = [0, 1, "x", [], {}, { v: 1, blobs: "no" }, { v: 1, mentions: 3 }, NaN, true, () => 1, Symbol.iterator.toString()];
    for (const state of junk) {
      for (const content of [plain(), { text: undefined as unknown as string, mediaCount: NaN }, { text: "@@@ #", mediaCount: -3 }]) {
        const step = stepForContent(state, content);
        expect(typeof step.name).toBe("string");
        expect(typeof step.mayPublish).toBe("boolean");
      }
    }
  });
});

describe("mentionHandles", () => {
  it("returns distinct normalised handles", () => {
    expect(mentionHandles("@A.bsky.social @a.bsky.social @b.bsky.social")).toEqual(["a.bsky.social", "b.bsky.social"]);
    expect(mentionHandles("none here")).toEqual([]);
  });
});
