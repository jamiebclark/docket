import { describe, expect, it } from "vitest";
import { stepForContent } from "./steps";

const at = "2026-10-08T12:00:00.000Z";
const video = { kinds: ["video"] as const, mediaCount: 1 };
const content = (text = "hello") => ({ text, ...video });
const up = { jobId: "j", url: "https://m/x", sizeBytes: 12_000_000, partSizeBytes: 5_000_000, partCount: 3, expiresAt: at, pdsHost: "pds.test" };
const state = (v: object) => ({ v: 1, video: v });

describe("stepForContent: video", () => {
  it("starts at the limits check, reserving one unit", () => {
    expect(stepForContent(null, content())).toEqual({ name: "check_upload_limits", mayPublish: false, allowance: { units: 1, retryUnits: 0 } });
  });
  it("reserves nothing for the hourly re-check of a limit wait", () => {
    expect(stepForContent(state({ phase: "limits", limitWaitSince: at }), content())).toEqual({ name: "check_upload_limits", mayPublish: false });
  });
  it("maps every phase to one step", () => {
    expect(stepForContent(state({ phase: "start", pdsHost: "pds.test" }), content())).toEqual({ name: "start_upload", mayPublish: false, allowance: { units: 0, retryUnits: 1 } });
    expect(stepForContent(state({ phase: "parts", ...up, partsSent: 0 }), content())).toEqual({ name: "upload_part_1", mayPublish: false });
    expect(stepForContent(state({ phase: "parts", ...up, partsSent: 2 }), content())).toEqual({ name: "upload_part_3", mayPublish: false });
    expect(stepForContent(state({ phase: "finish", ...up, partsSent: 3 }), content())).toEqual({ name: "finish_upload", mayPublish: false });
    expect(stepForContent(state({ phase: "job", pollJobId: "j", finishedAt: at }), content())).toEqual({ name: "check_job", mayPublish: false });
  });
  it("only create_post may publish", () => {
    const blob = { $type: "blob", ref: { $link: "c" }, mimeType: "video/mp4", size: 1 };
    expect(stepForContent(state({ phase: "ready", blob }), content())).toEqual({ name: "create_post", mayPublish: true });
    for (const s of [null, state({ phase: "limits" }), state({ phase: "start", pdsHost: "p.test" }), state({ phase: "job", pollJobId: "j", finishedAt: at })]) {
      expect(stepForContent(s, content()).mayPublish).toBe(false);
    }
  });
  it("resolves mentions first, only when the text has them", () => {
    expect(stepForContent(null, content("hi @a.bsky.social")).name).toBe("resolve_mentions");
    expect(stepForContent({ v: 1, mentions: {} }, content("hi @a.bsky.social")).name).toBe("check_upload_limits");
    expect(stepForContent(null, content("no mention")).name).toBe("check_upload_limits");
  });
  it("is unreadable when the upload is inconsistent for its phase", () => {
    expect(stepForContent(state({ phase: "ready" }), content())).toEqual({ name: "invalid_state", mayPublish: false });
    expect(stepForContent(state({ phase: "parts", ...up, partsSent: 3 }), content()).name).toBe("invalid_state");
  });
  it("starts again when the post's media changed", () => {
    expect(stepForContent(state({ phase: "ready", blob: { $type: "blob", ref: { $link: "c" }, mimeType: "video/mp4", size: 1 } }), { text: "x", mediaCount: 1, kinds: ["image"] }).name).toBe("upload_image_1");
    const imageBlob = { $type: "blob", ref: { $link: "c" }, mimeType: "image/jpeg", size: 1 };
    expect(stepForContent({ v: 1, blobs: [imageBlob] }, content()).name).toBe("check_upload_limits");
  });
});

describe("stepForContent: unchanged for text and images", () => {
  it("old states drive the same steps", () => {
    expect(stepForContent({ v: 1, blobs: [] }, { text: "t", mediaCount: 0 })).toEqual({ name: "create_post", mayPublish: true });
    expect(stepForContent({ v: 1, blobs: [] }, { text: "t", mediaCount: 1, kinds: ["image"] })).toEqual({ name: "upload_image_1", mayPublish: false });
    expect(stepForContent(null, { text: "t", mediaCount: 2, kinds: ["image", "image"] }).name).toBe("upload_image_1");
  });
  it("two videos are not treated as one", () => {
    expect(stepForContent(null, { text: "t", mediaCount: 2, kinds: ["video", "video"] }).name).toBe("upload_image_1");
  });
});
