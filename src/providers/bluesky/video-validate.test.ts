import { describe, expect, it } from "vitest";
import type { MediaItem } from "../types";
import { blueskyCapabilities as caps } from "./capabilities";
import { validateBluesky } from "./validate";

const img = (): MediaItem => ({ url: "https://m.test/a.jpg", mimeType: "image/jpeg", width: 1000, height: 1000, bytes: 1000, altText: "a" });
const vid = (over: Partial<MediaItem> = {}): MediaItem => ({
  url: "https://m.test/a.mp4",
  mimeType: "video/mp4",
  kind: "video",
  width: 1080,
  height: 1920,
  bytes: 20_000_000,
  altText: "",
  video: { container: "mp4", videoCodec: "h264", audioCodec: "aac", durationSeconds: 40, frameRate: 30 },
  ...over,
});
const run = (media: MediaItem[]) => validateBluesky({ text: "x", media }, caps);

describe("validateBluesky video", () => {
  it("accepts one fitting video with no issues", () => {
    expect(run([vid()])).toEqual([]);
  });

  it("refuses two videos in Bluesky's words, keeping code, field, count and limit", () => {
    const issue = run([vid(), vid()]).find((i) => i.code === "too_many_videos");
    expect(issue).toMatchObject({ severity: "error", field: "media", count: 2, limit: 1 });
    expect(issue?.message).toBe("Bluesky takes one video per post; this post has 2.");
  });

  it("refuses a video with an image in Bluesky's words", () => {
    const issue = run([vid(), img()]).find((i) => i.code === "video_with_images");
    expect(issue).toMatchObject({ severity: "error", field: "media" });
    expect(issue?.message).toBe("Bluesky takes one video per post with no images alongside it.");
  });

  it("puts no alt text limit on a video", () => {
    expect(run([vid({ altText: "a".repeat(5000) })])).toEqual([]);
  });

  it("leaves text-only and image issues as they were", () => {
    expect(run([])).toEqual([]);
    expect(run([img(), img(), img(), img()])).toEqual([]);
    expect(run([img(), img(), img(), img(), img()]).map((i) => i.code)).toContain("too_many_images");
  });
});
