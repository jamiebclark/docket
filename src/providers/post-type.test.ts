import { describe, expect, it } from "vitest";
import { choiceFor, offeredPostTypes, postTypeLabel, resolvePostType, shapeOf } from "./post-type";
import { getProvider } from "./registry";
import type { MediaItem, ProviderCapabilities } from "./types";
import { validateAgainstCapabilities } from "./validation";

const mock = getProvider("mock").capabilities;
const withChoice: ProviderCapabilities = {
  ...mock,
  postTypes: [...mock.postTypes, "reel"],
  postTypeChoices: [
    {
      shape: "single_video",
      options: [
        { type: "video", label: "Feed video", description: "Feed and Reels." },
        { type: "reel", label: "Reel", description: "Reels only." },
      ],
      default: "video",
    },
  ],
};
const img = { kind: "image" as const };
const vid = { kind: "video" as const };

describe("shapeOf", () => {
  it("names the shape", () => {
    expect(shapeOf([])).toBe("none");
    expect(shapeOf([{}])).toBe("single_image");
    expect(shapeOf([vid])).toBe("single_video");
    expect(shapeOf([img, vid])).toBe("multiple");
  });
});

describe("resolvePostType", () => {
  it("follows the contract table", () => {
    expect(resolvePostType(withChoice, [], "reel")).toBe("text");
    expect(resolvePostType(withChoice, [img], "reel")).toBe("image");
    expect(resolvePostType(withChoice, [vid], "reel")).toBe("reel");
    expect(resolvePostType(withChoice, [vid], null)).toBe("video");
    expect(resolvePostType(mock, [vid], "reel")).toBe("video");
    expect(resolvePostType(null, [vid], null)).toBe("video");
    expect(resolvePostType(withChoice, [img, img], null)).toBe("carousel");
    expect(resolvePostType(withChoice, [vid, img], null)).toBe("carousel");
  });
  it("falls back to the default for an unoffered value", () => {
    expect(resolvePostType(withChoice, [vid], "story")).toBe("video");
  });
  it("resolves a stored reel on a two-item post to carousel", () => {
    expect(resolvePostType(withChoice, [vid, vid], "reel")).toBe("carousel");
  });
});

describe("choice helpers", () => {
  it("finds the choice only for its shape", () => {
    expect(choiceFor(withChoice, [vid])?.default).toBe("video");
    expect(choiceFor(withChoice, [img])).toBeNull();
    expect(choiceFor(mock, [vid])).toBeNull();
    expect(choiceFor(null, [vid])).toBeNull();
  });
  it("lists offered types and labels", () => {
    expect(offeredPostTypes(withChoice)).toEqual(["video", "reel"]);
    expect(offeredPostTypes(mock)).toEqual([]);
    expect(postTypeLabel(withChoice, "reel")).toBe("Reel");
    expect(postTypeLabel(withChoice, "carousel")).toBe("carousel item");
    expect(postTypeLabel(withChoice, "image")).toBe("image");
  });
});

describe("mock keeps its 018 refusals", () => {
  const item = (kind: "image" | "video"): MediaItem => ({
    url: "u", mimeType: kind === "video" ? "video/mp4" : "image/png", width: 1080, height: 1920, bytes: 10, altText: "a", kind,
    ...(kind === "video" ? { video: { container: "mp4", durationSeconds: 5, frameRate: 30, videoCodec: "h264", audioCodec: "aac" } } : {}),
  });
  const codes = (media: MediaItem[]) => validateAgainstCapabilities({ text: "hi", media }, mock).map((i) => i.code);
  it("refuses two videos and a video with an image", () => {
    expect(codes([item("video"), item("video")])).toContain("too_many_videos");
    expect(codes([item("video"), item("image")])).toContain("video_with_images");
  });
});
