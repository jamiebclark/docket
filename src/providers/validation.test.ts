import { describe, expect, it } from "vitest";
import { inferPostType, validateAgainstCapabilities } from "./validation";
import type { MediaItem, ProviderCapabilities } from "./types";

const caps: ProviderCapabilities = {
  text: { maxLength: 10, countingRule: "graphemes" },
  media: { maxImages: 2, allowedMimeTypes: ["image/png"], maxBytesPerFile: 1000, required: false },
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
});
