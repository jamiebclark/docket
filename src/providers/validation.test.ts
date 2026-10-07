import { describe, expect, it } from "vitest";
import { inferPostType, validateAgainstCapabilities } from "./validation";
import type { MediaItem, ProviderCapabilities } from "./types";

const caps: ProviderCapabilities = {
  text: { maxLength: 10, countingRule: "graphemes" },
  media: { maxImages: 2, allowedMimeTypes: ["image/png"], maxBytesPerFile: 1000, required: false },
  video: { maxVideos: 0 },
  textOnlyAllowed: true,
  postTypes: ["text", "image", "carousel"],
};
const img = (over: Partial<MediaItem> = {}): MediaItem => ({
  url: "http://x/a.png", mimeType: "image/png", width: 1, height: 1, bytes: 10, altText: "alt", ...over,
});
const codes = (text: string, media: MediaItem[] = [], c = caps) =>
  validateAgainstCapabilities({ text, media }, c).map((i) => i.code);

describe("inferPostType", () => {
  it("is text / image / carousel by media count", () => {
    expect(inferPostType({ text: "", media: [] })).toBe("text");
    expect(inferPostType({ text: "", media: [img()] })).toBe("image");
    expect(inferPostType({ text: "", media: [img(), img()] })).toBe("carousel");
  });
});

describe("validateAgainstCapabilities", () => {
  it("accepts text-only and text with an image", () => {
    expect(codes("hello")).toEqual([]);
    expect(codes("hello", [img()])).toEqual([]);
  });
  it("flags an empty post", () => {
    expect(codes("  ")).toEqual(["empty_post"]);
  });
  it("counts text by the rule and reports count and limit", () => {
    const [issue] = validateAgainstCapabilities({ text: "👨‍👩‍👧‍👦".repeat(11), media: [] }, caps);
    expect(issue).toMatchObject({ code: "text_too_long", field: "text", count: 11, limit: 10 });
    expect(codes("a".repeat(10))).toEqual([]);
    expect(codes("é".repeat(6), [], { ...caps, text: { maxLength: 10, countingRule: "utf8_bytes" } })).toEqual(["text_too_long"]);
  });
  it("caps hashtags and mentions per occurrence, only when declared", () => {
    const capped = { ...caps, text: { maxLength: 1000, countingRule: "graphemes" as const, maxHashtags: 30, maxMentions: 20 } };
    const tags = (n: number) => Array.from({ length: n }, (_, i) => `#t${i}`).join(" ");
    const ats = (n: number) => Array.from({ length: n }, (_, i) => `@u${i}`).join(" ");
    expect(validateAgainstCapabilities({ text: tags(31), media: [] }, capped)[0]).toMatchObject({ code: "too_many_hashtags", field: "text", count: 31, limit: 30 });
    expect(validateAgainstCapabilities({ text: ats(21), media: [] }, capped)[0]).toMatchObject({ code: "too_many_mentions", field: "text", count: 21, limit: 20 });
    expect(codes(tags(30), [], capped)).toEqual([]);
    expect(codes(ats(20), [], capped)).toEqual([]);
    expect(codes(`${tags(31)} ${ats(21)}`, [], { ...caps, text: { maxLength: 1000, countingRule: "graphemes" } })).toEqual([]);
  });
  it("rejects text-only when not allowed, and requires media when required", () => {
    expect(codes("hi", [], { ...caps, textOnlyAllowed: false })).toEqual(["text_only_not_allowed"]);
    expect(codes("hi", [], { ...caps, media: { ...caps.media, required: true } })).toEqual(["media_required"]);
  });
  it("flags too many images, mime, size, and warns on alt text, per item", () => {
    const issues = validateAgainstCapabilities(
      { text: "x", media: [img(), img({ mimeType: "image/gif" }), img({ bytes: 5000, altText: "" })] },
      caps,
    );
    expect(issues.map((i) => [i.code, i.field, i.severity])).toEqual([
      ["too_many_images", "media", "error"],
      ["mime_not_allowed", "media.1", "error"],
      ["file_too_large", "media.2", "error"],
      ["missing_alt_text", "media.2", "warning"],
    ]);
  });
  it("flags unsupported post types", () => {
    expect(codes("x", [img(), img()], { ...caps, postTypes: ["text", "image"] })).toEqual(["unsupported_post_type"]);
  });
  it("orders text before postType before media", () => {
    const issues = validateAgainstCapabilities(
      { text: "x".repeat(20), media: [img({ mimeType: "image/gif" })] },
      { ...caps, postTypes: ["text"] },
    );
    expect(issues.map((i) => i.field)).toEqual(["text", "postType", "media.0"]);
  });
  it("flags alt text over maxAltTextLength", () => {
    const c = { ...caps, media: { ...caps.media, maxAltTextLength: 5 } };
    expect(codes("x", [img({ altText: "123456" })], c)).toEqual(["alt_text_too_long"]);
    expect(codes("x", [img({ altText: "12345" })], c)).toEqual([]);
  });
});

const videoCaps: ProviderCapabilities = {
  ...caps,
  video: {
    maxVideos: 1,
    withImages: false,
    containers: ["mp4"],
    videoCodecs: ["h264"],
    audioCodecs: ["aac"],
    silentAllowed: false,
    maxBytes: 1000,
    minDurationSeconds: 1,
    maxDurationSeconds: 60,
    minWidth: 100,
    maxWidth: 1920,
    minHeight: 100,
    maxHeight: 1920,
    minAspectRatio: 9 / 16,
    maxAspectRatio: 16 / 9,
    maxFrameRate: 60,
  },
  postTypes: ["text", "image", "carousel", "video"],
};
const vid = (over: Partial<MediaItem> = {}, facts: Partial<NonNullable<MediaItem["video"]>> = {}): MediaItem => ({
  url: "http://x/a.mp4",
  mimeType: "video/mp4",
  width: 1280,
  height: 720,
  bytes: 500,
  altText: "",
  kind: "video",
  status: "ready",
  video: { container: "mp4", durationSeconds: 20, frameRate: 30, videoCodec: "h264", audioCodec: "aac", ...facts },
  ...over,
});

describe("video validation", () => {
  it("infers a video post type", () => {
    expect(inferPostType({ text: "", media: [img(), vid()] })).toBe("video");
  });
  it("accepts a clip inside every bound", () => {
    expect(codes("x", [vid()], videoCaps)).toEqual([]);
  });
  it("refuses video where maxVideos is 0, without unsupported_post_type", () => {
    const issues = validateAgainstCapabilities({ text: "x", media: [vid()] }, caps);
    expect(issues.map((i) => [i.code, i.field])).toEqual([["video_not_accepted", "media.0"]]);
    expect(issues[0]!.message).toBe("This account does not accept video yet.");
  });
  it("applies unsupported_post_type when video is accepted but not a post type", () => {
    expect(codes("x", [vid()], { ...videoCaps, postTypes: ["text", "image"] })).toEqual(["unsupported_post_type"]);
  });
  it("counts images only for too_many_images, and keeps alt rules off videos", () => {
    const c = { ...videoCaps, video: { ...videoCaps.video, withImages: true } };
    expect(codes("x", [img(), img(), vid()], c)).toEqual([]);
    expect(codes("x", [img(), img(), img(), vid()], c)).toEqual(["too_many_images"]);
  });
  it("limits videos and mixing with images", () => {
    expect(validateAgainstCapabilities({ text: "x", media: [vid(), vid()] }, videoCaps)[0]).toMatchObject({
      code: "too_many_videos",
      field: "media",
      count: 2,
      limit: 1,
    });
    expect(codes("x", [img(), vid()], videoCaps)).toEqual(["video_with_images"]);
  });
  it.each([
    ["container", { container: "mov" as const }, "video_container_not_allowed"],
    ["video codec", { videoCodec: "hevc" }, "video_codec_not_allowed"],
    ["audio codec", { audioCodec: "opus" }, "audio_codec_not_allowed"],
    ["silent", { audioCodec: null }, "audio_required"],
    ["too short", { durationSeconds: 0.5 }, "video_too_short"],
    ["too long", { durationSeconds: 222 }, "video_too_long"],
    ["frame rate", { frameRate: 120 }, "video_frame_rate_too_high"],
  ])("flags %s", (_n, facts, code) => {
    expect(codes("x", [vid({}, facts)], videoCaps)).toEqual([code]);
  });
  it("refuses a container the provider does not list", () => {
    expect(codes("x", [vid({ mimeType: "video/quicktime" }, { container: "mov" })], videoCaps)).toEqual(["video_container_not_allowed"]);
    expect(codes("x", [vid({ mimeType: "video/quicktime" }, { container: "mov" })], { ...videoCaps, video: { ...videoCaps.video, containers: ["mp4", "mov"] } })).toEqual([]);
  });
  it("accepts a silent video unless the provider forbids it", () => {
    const silent = vid({}, { audioCodec: null });
    expect(codes("x", [silent], { ...videoCaps, video: { ...videoCaps.video, silentAllowed: true } })).toEqual([]);
    expect(codes("x", [silent], { ...videoCaps, video: { ...videoCaps.video, silentAllowed: undefined } })).toEqual([]);
    expect(codes("x", [silent], videoCaps)).toEqual(["audio_required"]);
  });
  it("keeps boundaries inclusive", () => {
    expect(codes("x", [vid({ bytes: 1000 }, { durationSeconds: 60, frameRate: 60 })], videoCaps)).toEqual([]);
    expect(codes("x", [vid({ bytes: 1001 })], videoCaps)).toEqual(["video_too_large"]);
    expect(codes("x", [vid({}, { durationSeconds: 1 })], videoCaps)).toEqual([]);
  });
  it("checks size and aspect, passing an unknown frame rate", () => {
    expect(codes("x", [vid({ width: 2000, height: 1200 })], videoCaps)).toEqual(["video_too_big"]);
    expect(codes("x", [vid({ width: 50, height: 100 })], videoCaps)).toEqual(["video_too_small", "video_aspect_out_of_range"]);
    expect(codes("x", [vid({ width: 1920, height: 1000 })], videoCaps)).toEqual(["video_aspect_out_of_range"]);
    expect(codes("x", [vid({ width: 1600, height: 900 })], videoCaps)).toEqual([]);
    expect(codes("x", [vid({}, { frameRate: null })], videoCaps)).toEqual([]);
  });
  it("names the limit and value", () => {
    const [issue] = validateAgainstCapabilities({ text: "x", media: [vid({}, { durationSeconds: 222 })] }, videoCaps);
    expect(issue).toMatchObject({ message: "Video 1 is 3:42 long; the limit is 1 minute.", count: 222, limit: 60 });
  });
  it("blocks processing and failed items with no other rule", () => {
    const issues = validateAgainstCapabilities(
      { text: "x", media: [vid({ status: "processing", video: undefined }), vid({ status: "failed", failureReason: "Docket could not read this video", video: undefined })] },
      { ...videoCaps, video: { ...videoCaps.video, maxVideos: 2 } },
    );
    expect(issues.map((i) => [i.code, i.field])).toEqual([
      ["media_processing", "media.0"],
      ["media_failed", "media.1"],
    ]);
    expect(issues[1]!.message).toBe("Video 2 failed: Docket could not read this video. Remove it to continue.");
  });
});
