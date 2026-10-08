import { describe, expect, it } from "vitest";
import { instagramCapabilities as caps } from "./capabilities";
import { validateInstagram } from "./validate";
import type { MediaItem, PostType, VideoFacts } from "../types";

const img = (over: Partial<MediaItem> = {}): MediaItem => ({
  url: "https://m.test/a.jpg",
  mimeType: "image/jpeg",
  width: 1080,
  height: 1080,
  bytes: 100_000,
  altText: "a",
  ...over,
});
const run = (text: string, media: MediaItem[]) => validateInstagram({ text, media }, caps);
const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

describe("validateInstagram", () => {
  it("maps text-only to media_required on postType", () => {
    const issues = run("hello", []);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: "error", code: "media_required", field: "postType" });
  });

  it("accepts 10 images and rejects 11", () => {
    expect(codes(run("x", Array.from({ length: 10 }, () => img())))).not.toContain("too_many_images");
    expect(codes(run("x", Array.from({ length: 11 }, () => img())))).toContain("too_many_images");
  });

  it("allows aspect 0.8 and 1.91 inclusive and names the image outside", () => {
    expect(codes(run("x", [img({ width: 800, height: 1000 })]))).not.toContain("aspect_ratio_out_of_range");
    expect(codes(run("x", [img({ width: 1910, height: 1000 })]))).not.toContain("aspect_ratio_out_of_range");
    const issues = run("x", [img(), img({ width: 799, height: 1000 })]);
    const bad = issues.find((i) => i.code === "aspect_ratio_out_of_range");
    expect(bad).toMatchObject({ severity: "error", field: "media.1" });
    expect(bad?.message).toContain("Image 2");
    expect(codes(run("x", [img({ width: 1911, height: 1000 })]))).toContain("aspect_ratio_out_of_range");
  });

  it("allows alt text of 1000 and rejects 1001", () => {
    expect(codes(run("x", [img({ altText: "a".repeat(1000) })]))).not.toContain("alt_text_too_long");
    expect(codes(run("x", [img({ altText: "a".repeat(1001) })]))).toContain("alt_text_too_long");
  });

  it("notes PNG, oversize and wide images without blocking", () => {
    const issues = run("x", [img({ mimeType: "image/png", bytes: 9_000_000, width: 2000, height: 2000 })]);
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(codes(issues)).toEqual(expect.arrayContaining(["media_will_convert", "media_will_compress", "media_will_downscale"]));
  });

  it("notes a mixed-aspect carousel crop but not a uniform one", () => {
    expect(codes(run("x", [img(), img({ width: 1000, height: 1250 })]))).toContain("carousel_crop");
    expect(codes(run("x", [img(), img()]))).not.toContain("carousel_crop");
  });

  it("counts the caption in code points against 2200", () => {
    expect(codes(run("😀".repeat(2200), [img()]))).not.toContain("text_too_long");
    expect(codes(run("😀".repeat(2201), [img()]))).toContain("text_too_long");
  });
});

describe("validateInstagram video", () => {
  const vid = (facts: Partial<VideoFacts> = {}, over: Partial<MediaItem> = {}): MediaItem => ({
    url: "https://m.test/a.mp4",
    mimeType: "video/mp4",
    kind: "video",
    width: 1080,
    height: 1920,
    bytes: 1_000_000,
    altText: "",
    video: { container: "mp4", videoCodec: "h264", audioCodec: "aac", durationSeconds: 10, frameRate: 30, ...facts },
    ...over,
  });
  const runT = (media: MediaItem[], postType?: PostType) => validateInstagram({ text: "x", media, postType }, caps);
  const errors = (issues: { severity: string }[]) => issues.filter((i) => i.severity === "error");

  it("accepts a fitting video as Feed video and Reel", () => {
    expect(errors(runT([vid()]))).toEqual([]);
    expect(errors(runT([vid()], "reel"))).toEqual([]);
  });

  it("names the post type and says Docket does not adjust video", () => {
    const reel = runT([vid({ durationSeconds: 960 })], "reel").find((i) => i.code === "video_too_long");
    expect(reel?.message).toContain("for an Instagram Reel.");
    const feed = runT([vid({ durationSeconds: 960 })]).find((i) => i.code === "video_too_long");
    expect(feed?.message).toContain("for an Instagram Feed video.");
  });

  it("refuses a frame rate below 23", () => {
    expect(codes(runT([vid({ frameRate: 15 })]))).toContain("video_frame_rate_too_low");
    expect(codes(runT([vid({ frameRate: 23 })]))).not.toContain("video_frame_rate_too_low");
  });

  it("applies carousel limits to mixed carousels and refuses 11 items", () => {
    expect(errors(runT([img(), vid({}, { width: 1080, height: 1350 })], "carousel"))).toEqual([]);
    const tall = runT([img(), vid()], "carousel").find((i) => i.code === "video_aspect_out_of_range");
    expect(tall?.message).toContain("for an Instagram carousel item.");
    const eleven = Array.from({ length: 11 }, () => vid({}, { width: 1080, height: 1350 }));
    expect(codes(runT(eleven, "carousel"))).toContain("too_many_items");
  });

  it("counts video in the crop note but gives it no image notes or alt text warning", () => {
    const issues = runT([img(), vid({}, { width: 1080, height: 1350 })], "carousel");
    expect(codes(issues)).toContain("carousel_crop");
    expect(codes(issues)).not.toContain("missing_alt_text");
    expect(codes(issues)).not.toContain("media_will_convert");
  });

  it("says posts need an image or video", () => {
    expect(run("hello", [])[0]?.message).toBe("Instagram posts need at least one image or video.");
  });
});
