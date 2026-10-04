import { describe, expect, it } from "vitest";
import { facebookCapabilities as caps, FACEBOOK_MAX_IMAGES, FACEBOOK_MAX_TEXT } from "./capabilities";
import { validateFacebook } from "./validate";
import type { MediaItem } from "../types";

const img = (): MediaItem => ({ url: "https://m.test/a.jpg", mimeType: "image/jpeg", width: 1000, height: 1000, bytes: 1000, altText: "a" });
const run = (text: string, n = 0) => validateFacebook({ text, media: Array.from({ length: n }, img) }, caps);
const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

describe("validateFacebook", () => {
  it("allows a text-only post", () => {
    expect(run("hello")).toEqual([]);
  });

  it("allows the maximum number of images and rejects one more", () => {
    expect(codes(run("x", FACEBOOK_MAX_IMAGES))).not.toContain("too_many_images");
    const over = run("x", FACEBOOK_MAX_IMAGES + 1).find((i) => i.code === "too_many_images");
    expect(over).toMatchObject({ severity: "error", count: FACEBOOK_MAX_IMAGES + 1, limit: FACEBOOK_MAX_IMAGES });
  });

  it("counts text in code points at the limit", () => {
    expect(codes(run("😀".repeat(FACEBOOK_MAX_TEXT)))).not.toContain("text_too_long");
    const over = run("😀".repeat(FACEBOOK_MAX_TEXT + 1)).find((i) => i.code === "text_too_long");
    expect(over).toMatchObject({ count: FACEBOOK_MAX_TEXT + 1, limit: FACEBOOK_MAX_TEXT });
  });
});
