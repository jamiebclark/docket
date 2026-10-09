import { describe, expect, it } from "vitest";
import { TIKTOK_DEFAULT_PUBLISH_LIMIT, TIKTOK_TEXT_RULE, tiktokCapabilities } from "./capabilities";

describe("tiktok capabilities", () => {
  it("declares captions, photos and one video, and refuses text-only posts", () => {
    expect(tiktokCapabilities.text.maxLength).toBe(2200);
    expect(tiktokCapabilities.media.maxImages).toBe(35);
    expect(tiktokCapabilities.media.required).toBe(true);
    expect(tiktokCapabilities.textOnlyAllowed).toBe(false);
    expect(tiktokCapabilities.video.maxVideos).toBe(1);
    expect(tiktokCapabilities.video.withImages).toBe(false);
    expect(tiktokCapabilities.postTypes).toEqual(["image", "carousel", "video"]);
  });

  it("counts text in UTF-16 units", () => {
    expect(TIKTOK_TEXT_RULE.name).toBe("utf16");
    expect(TIKTOK_TEXT_RULE.count("abc")).toBe(3);
    expect(TIKTOK_TEXT_RULE.count("😀")).toBe(2);
    expect(tiktokCapabilities.text.countingRule).toBe(TIKTOK_TEXT_RULE);
  });

  it("limits publishing to 15 a day", () => {
    expect(TIKTOK_DEFAULT_PUBLISH_LIMIT).toEqual({ count: 15, windowSeconds: 86_400 });
  });
});
