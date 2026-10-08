import { describe, expect, it } from "vitest";
import { BLUESKY_VIDEO, BLUESKY_VIDEO_ALLOWANCE, BLUESKY_VIDEO_NOTES, blueskyCapabilities as caps } from "./capabilities";
import { resolvePostType } from "../post-type";
import { videoLimitsFor } from "../validation";

describe("Bluesky's capabilities declaration", () => {
  it("declares one MP4 H.264/AAC video up to 3 minutes and 300 MB, silent allowed, no images alongside", () => {
    expect(caps.video).toMatchObject({
      maxVideos: 1,
      withImages: false,
      containers: ["mp4"],
      videoCodecs: ["h264"],
      audioCodecs: ["aac"],
      silentAllowed: true,
      maxBytes: 300_000_000,
      maxDurationSeconds: 180,
    });
    expect(BLUESKY_VIDEO.maxBytes).toBe(300_000_000);
  });

  it("offers the video post type and no post type choice", () => {
    expect(caps.postTypes).toEqual(["text", "image", "carousel", "video"]);
    expect(caps.postTypeChoices).toBeUndefined();
    const item = { url: "https://m.test/a.mp4", mimeType: "video/mp4", kind: "video" as const, width: 1080, height: 1920, bytes: 1, altText: "" };
    expect(resolvePostType(caps, [item], null)).toBe("video");
  });

  it("carries the two notes and the daily allowance", () => {
    expect(videoLimitsFor(caps, "video").maxVideos).toBe(1);
    expect(caps.video.byPostType?.video?.notes).toEqual([...BLUESKY_VIDEO_NOTES]);
    expect(BLUESKY_VIDEO_NOTES).toHaveLength(2);
    expect(BLUESKY_VIDEO_ALLOWANCE).toMatchObject({ count: 25, windowSeconds: 86_400 });
  });

  it("leaves the text and image limits as they were", () => {
    expect(caps.text).toEqual({ maxLength: 300, countingRule: "graphemes" });
    expect(caps.media).toMatchObject({ maxImages: 4, maxBytesPerFile: 2_000_000, required: false });
    expect(caps.textOnlyAllowed).toBe(true);
  });
});
