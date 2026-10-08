import { describe, expect, it } from "vitest";
import { facebookStepFor } from "./steps";

const c = (mediaCount: number) => ({ text: "x", mediaCount });
const ids = (n: number) => ({ v: 1, photoIds: Array.from({ length: n }, (_, i) => `p${i}`) });

describe("facebookStepFor", () => {
  it("text → publish_feed", () => {
    expect(facebookStepFor(null, c(0))).toEqual({ name: "publish_feed", mayPublish: true });
  });
  it("one image → publish_photo", () => {
    expect(facebookStepFor(null, c(1))).toEqual({ name: "publish_photo", mayPublish: true });
  });
  it("N images → N non-publishing uploads then publish_feed", () => {
    expect(facebookStepFor(null, c(3))).toEqual({ name: "upload_photo_1", mayPublish: false });
    expect(facebookStepFor(ids(1), c(3))).toEqual({ name: "upload_photo_2", mayPublish: false });
    expect(facebookStepFor(ids(2), c(3))).toEqual({ name: "upload_photo_3", mayPublish: false });
    expect(facebookStepFor(ids(3), c(3))).toEqual({ name: "publish_feed", mayPublish: true });
  });
  it("is total on malformed state or counts", () => {
    for (const bad of [{}, "x", 5, { v: 2, photoIds: [] }, { v: 1, photoIds: [1] }, { v: 1 }]) {
      expect(facebookStepFor(bad, c(3))).toEqual({ name: "invalid", mayPublish: false });
    }
    expect(facebookStepFor(ids(4), c(3)).name).toBe("invalid");
    expect(facebookStepFor(null, c(11)).name).toBe("invalid");
    expect(facebookStepFor(null, c(Number.NaN))).toEqual({ name: "publish_feed", mayPublish: true });
  });
  it("state holds only photo ids", () => {
    expect(Object.keys(ids(2)).sort()).toEqual(["photoIds", "v"]);
  });

  describe("one video", () => {
    const v = (postType?: "video" | "reel") => ({ text: "x", mediaCount: 1, kinds: ["video"] as const, ...(postType ? { postType } : {}) });
    it("no choice → publish_video", () => {
      expect(facebookStepFor(null, v())).toEqual({ name: "publish_video", mayPublish: true });
    });
    it("video choice → publish_video", () => {
      expect(facebookStepFor(null, v("video"))).toEqual({ name: "publish_video", mayPublish: true });
    });
    it("an image-only post still reads as a photo", () => {
      expect(facebookStepFor(null, { text: "x", mediaCount: 1, kinds: ["image"] })).toEqual({ name: "publish_photo", mayPublish: true });
    });
  });

  describe("Reel", () => {
    const r = { text: "x", mediaCount: 1, kinds: ["video"] as const, postType: "reel" as const };
    const st = (o: Record<string, unknown> = {}) => ({
      v: 1, kind: "reel", videoId: "55", uploadUrl: "https://rupload.facebook.com/video-upload/55",
      startedAt: "t", uploadedAt: null, uploadComplete: false, uploadChecks: 0, finishedAt: null, publishChecks: 0, ...o,
    });
    it("no state → start_reel reserving one unit", () => {
      expect(facebookStepFor(null, r)).toEqual({ name: "start_reel", mayPublish: false, allowance: { units: 1, retryUnits: 1 } });
    });
    it("walks upload_reel → check_upload → finish_reel → check_publish", () => {
      expect(facebookStepFor(st(), r).name).toBe("upload_reel");
      expect(facebookStepFor(st({ uploadedAt: "t" }), r).name).toBe("check_upload");
      expect(facebookStepFor(st({ uploadedAt: "t", uploadComplete: true }), r)).toEqual({ name: "finish_reel", mayPublish: true });
      expect(facebookStepFor(st({ uploadedAt: "t", uploadComplete: true, finishedAt: "t" }), r)).toEqual({
        name: "check_publish", mayPublish: false, afterPublish: true,
      });
    });
    it("a finished Reel stays check_publish whatever the content", () => {
      const done = st({ uploadedAt: "t", uploadComplete: true, finishedAt: "t" });
      expect(facebookStepFor(done, { text: "x", mediaCount: 0 }).name).toBe("check_publish");
      expect(facebookStepFor(done, { ...r, postType: "video" }).name).toBe("check_publish");
    });
    it("an unfinished Reel state is ignored when the choice changes", () => {
      expect(facebookStepFor(st({ uploadedAt: "t" }), { ...r, postType: "video" }).name).toBe("publish_video");
      expect(facebookStepFor(st(), { text: "x", mediaCount: 1, kinds: ["image"] }).name).toBe("publish_photo");
    });
    it("an unreadable state on a video is invalid after publish; on an image it is plain invalid", () => {
      expect(facebookStepFor(st({ uploadComplete: true }), r)).toEqual({ name: "invalid", mayPublish: false, afterPublish: true });
      expect(facebookStepFor({ junk: 1 }, r).afterPublish).toBe(true);
      expect(facebookStepFor({ junk: 1 }, { text: "x", mediaCount: 1 })).toEqual({ name: "invalid", mayPublish: false });
    });
  });
});