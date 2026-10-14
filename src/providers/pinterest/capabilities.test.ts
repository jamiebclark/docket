import { describe, expect, it } from "vitest";
import { UPLOAD_MIME_TYPES } from "@/lib/media/types";
import { PINTEREST_DEFAULT_PUBLISH_LIMIT, pinterestCapabilities } from "./capabilities";

describe("pinterest capabilities", () => {
  it("declares an 800-character text limit counted in code points", () => {
    expect(pinterestCapabilities.text.maxLength).toBe(800);
    expect(pinterestCapabilities.text.countingRule).toBe("code_points");
  });

  it("requires exactly one image of the three Pinterest MIME types, under 20 MB, with 500-char alt text", () => {
    expect(pinterestCapabilities.media.maxImages).toBe(1);
    expect(pinterestCapabilities.media.allowedMimeTypes).toEqual(["image/jpeg", "image/png", "image/webp"]);
    expect(pinterestCapabilities.media.maxBytesPerFile).toBe(20_000_000);
    expect(pinterestCapabilities.media.maxAltTextLength).toBe(500);
    expect(pinterestCapabilities.media.required).toBe(true);
  });

  it("declares no width, height or aspect bounds", () => {
    expect(pinterestCapabilities.media.minWidth).toBeUndefined();
    expect(pinterestCapabilities.media.maxWidth).toBeUndefined();
    expect(pinterestCapabilities.media.minHeight).toBeUndefined();
    expect(pinterestCapabilities.media.maxHeight).toBeUndefined();
  });

  it("takes no video and only image posts", () => {
    expect(pinterestCapabilities.video.maxVideos).toBe(0);
    expect(pinterestCapabilities.textOnlyAllowed).toBe(false);
    expect(pinterestCapabilities.postTypes).toEqual(["image"]);
  });

  it("defaults to 100 publishes per 60 seconds", () => {
    expect(PINTEREST_DEFAULT_PUBLISH_LIMIT).toEqual({ count: 100, windowSeconds: 60 });
  });

  it("pinterest: formats accepts every uploadable type without converting it", () => {
    expect(pinterestCapabilities.media.allowedMimeTypes).toEqual([...UPLOAD_MIME_TYPES]);
    expect(pinterestCapabilities.media.outputMimeType).toBe("image/jpeg");
  });
});
