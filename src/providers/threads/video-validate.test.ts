import { describe, expect, it } from "vitest";
import { threadsCapabilities as caps, THREADS_MAX_ITEMS, THREADS_VIDEO } from "./capabilities";
import { validateThreads } from "./validate";
import type { MediaItem, VideoFacts } from "../types";

const img = (): MediaItem => ({ url: "https://m.test/a.jpg", mimeType: "image/jpeg", width: 1000, height: 1000, bytes: 1000, altText: "a" });
const vid = (facts: Partial<VideoFacts> = {}, over: Partial<MediaItem> = {}): MediaItem => ({
  url: "https://m.test/a.mp4",
  mimeType: "video/mp4",
  kind: "video",
  width: 1080,
  height: 1920,
  bytes: 1_000_000,
  altText: "",
  video: { container: "mp4", videoCodec: "h264", audioCodec: "aac", durationSeconds: 30, frameRate: 30, ...facts },
  ...over,
});
const run = (media: MediaItem[], text = "x") => validateThreads({ text, media }, caps);
const errors = (media: MediaItem[]) => run(media).filter((i) => i.severity === "error");
const codes = (media: MediaItem[]) => errors(media).map((i) => i.code);
const msg = (media: MediaItem[], code: string) => run(media).find((i) => i.code === code)?.message;

describe("validateThreads video", () => {
  it("accepts a fitting video with no issues at all", () => {
    expect(run([vid()])).toEqual([]);
  });

  it("refuses a video over 5 minutes with Threads wording", () => {
    expect(codes([vid({ durationSeconds: 360 })])).toEqual(["video_too_long"]);
    expect(msg([vid({ durationSeconds: 360 })], "video_too_long")).toContain(
      "6 minutes long; the limit is 5 minutes for Threads. Docket does not crop, trim or convert video yet.",
    );
  });

  it("refuses a video over 1 GB and names the limit in GB", () => {
    const m = [vid({}, { bytes: 1_050_000_000 })];
    expect(codes(m)).toEqual(["video_too_large"]);
    expect(msg(m, "video_too_large")).toContain("1.05 GB; the limit is 1 GB for Threads");
  });

  it("refuses 2,560 px wide, VP9, Opus, 15 fps, 120 fps and out-of-range aspect", () => {
    expect(codes([vid({}, { width: 2560, height: 1440 })])).toEqual(["video_too_big"]);
    expect(msg([vid({}, { width: 2560, height: 1440 })], "video_too_big")).toContain("2560 px wide; the limit is 1920 px");
    expect(msg([vid({ videoCodec: "vp9" })], "video_codec_not_allowed")).toContain("VP9; allowed video codecs are H.264, HEVC");
    expect(msg([vid({ audioCodec: "opus" })], "audio_codec_not_allowed")).toContain("Opus audio");
    expect(msg([vid({ frameRate: 15 })], "video_frame_rate_too_low")).toContain("the minimum is 23 fps");
    expect(msg([vid({ frameRate: 120 })], "video_frame_rate_too_high")).toContain("the limit is 60 fps");
    expect(codes([vid({}, { width: 9, height: 1000 })])).toEqual(["video_aspect_out_of_range"]);
    expect(codes([vid({}, { width: 1801, height: 180 })])).toEqual(["video_aspect_out_of_range"]);
    expect(msg([vid({}, { width: 9, height: 1000 })], "video_aspect_out_of_range")).toContain("allowed is 1:100 to 10:1");
  });

  it("accepts no audio, an unknown frame rate and every inclusive limit", () => {
    expect(codes([vid({ audioCodec: null })])).toEqual([]);
    expect(codes([vid({ frameRate: null })])).toEqual([]);
    expect(codes([vid({ durationSeconds: 300, frameRate: 23 }, { bytes: 1e9, width: 1920, height: 1080 })])).toEqual([]);
    expect(codes([vid({ frameRate: 60 }, { width: 1800, height: 180 })])).toEqual([]);
    expect(codes([vid({}, { width: 19, height: 1900 })])).toEqual([]);
    expect(THREADS_VIDEO.maxBytes).toBe(1e9);
  });

  it("does not run the image planner on video (300 px wide) or check its alt text", () => {
    expect(run([vid({}, { width: 300, height: 533, altText: "a".repeat(2000) })])).toEqual([]);
  });

  it("flags only the offending item of a mixed carousel", () => {
    const bad = run([img(), vid(), img()].map((m, i) => (i === 2 ? vid({ frameRate: 120 }) : m)));
    expect(bad.filter((i) => i.severity === "error").map((i) => i.field)).toEqual(["media.2"]);
    expect(bad.find((i) => i.code === "video_frame_rate_too_high")?.message).toContain("Video 3 is 120 fps");
  });

  it("holds 20 mixed items and refuses 21 with too_many_items", () => {
    const mixed = (n: number) => Array.from({ length: n }, (_, i) => (i % 2 ? vid() : img()));
    expect(codes(mixed(THREADS_MAX_ITEMS))).toEqual([]);
    const over = run(mixed(21)).find((i) => i.code === "too_many_items");
    expect(over).toMatchObject({ severity: "error", field: "media", count: 21, limit: 20 });
    expect(over?.message).toContain("21 items");
  });

  it("keeps the image-only and video-only codes for 21 items of one kind", () => {
    const images = codes(Array.from({ length: 21 }, img));
    expect(images).toContain("too_many_images");
    expect(images).not.toContain("too_many_items");
    const videos = codes(Array.from({ length: 21 }, () => vid()));
    expect(videos).toContain("too_many_videos");
    expect(videos).not.toContain("too_many_items");
  });

  it("passes processing and failed media through unchanged", () => {
    expect(codes([vid({}, { status: "processing" })])).toContain("media_processing");
    expect(codes([vid({}, { status: "failed", failureReason: "bad" })])).toContain("media_failed");
  });

  it("orders issues text, postType, media", () => {
    const issues = validateThreads({ text: "x".repeat(600), media: [vid({ durationSeconds: 999 })] }, caps);
    const fields = issues.map((i) => i.field);
    expect(fields.indexOf("text")).toBeLessThan(fields.indexOf("media.0"));
  });

  it("never produces a 'will be converted' video note", () => {
    const notes = run([vid(), vid(), img()]).filter((i) => i.severity !== "error");
    expect(notes.filter((n) => n.field.startsWith("media.") && /convert/i.test(n.message) && n.code.startsWith("video"))).toEqual([]);
  });
});
