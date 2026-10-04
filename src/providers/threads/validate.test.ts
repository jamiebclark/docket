import { describe, expect, it } from "vitest";
import { threadsCapabilities as caps } from "./capabilities";
import { validateThreads } from "./validate";
import type { MediaItem } from "../types";

const img = (over: Partial<MediaItem> = {}): MediaItem => ({
  url: "https://m.test/a.jpg",
  mimeType: "image/jpeg",
  width: 1000,
  height: 1000,
  bytes: 100_000,
  altText: "a",
  ...over,
});
const run = (text: string, media: MediaItem[] = []) => validateThreads({ text, media }, caps);
const codes = (issues: { code: string }[]) => issues.map((i) => i.code);
const errors = (issues: { severity: string; code: string }[]) => issues.filter((i) => i.severity === "error").map((i) => i.code);

describe("validateThreads", () => {
  it("allows 500 ASCII characters and blocks 501", () => {
    expect(codes(run("a".repeat(500)))).not.toContain("text_too_long");
    const tooLong = run("a".repeat(501)).find((i) => i.code === "text_too_long");
    expect(tooLong).toMatchObject({ severity: "error", count: 501, limit: 500 });
  });

  it("counts emoji by bytes at the boundary", () => {
    expect(codes(run("a".repeat(496) + "😀"))).not.toContain("text_too_long");
    const over = run("a".repeat(496) + "😀😀").find((i) => i.code === "text_too_long");
    expect(over).toMatchObject({ count: 504, limit: 500 });
  });

  it("counts accented and CJK characters as one", () => {
    expect(codes(run("é".repeat(500)))).not.toContain("text_too_long");
    expect(codes(run("日".repeat(500)))).not.toContain("text_too_long");
    expect(codes(run("日".repeat(501)))).toContain("text_too_long");
  });

  it("blocks an empty post but allows text only", () => {
    expect(codes(run(""))).toContain("empty_post");
    expect(errors(run("hello"))).toEqual([]);
  });

  it("allows 20 images and rejects 21", () => {
    expect(codes(run("x", Array.from({ length: 20 }, () => img())))).not.toContain("too_many_images");
    expect(codes(run("x", Array.from({ length: 21 }, () => img())))).toContain("too_many_images");
  });

  it("blocks width 319 and allows 320", () => {
    expect(errors(run("x", [img({ width: 319, height: 319 })]))).toContain("image_too_small");
    expect(errors(run("x", [img({ width: 320, height: 320 })]))).toEqual([]);
  });

  it("notes width 1441 as a downscale and allows 1440", () => {
    expect(codes(run("x", [img({ width: 1440, height: 1440 })]))).not.toContain("media_will_downscale");
    const issues = run("x", [img({ width: 1441, height: 1441 })]);
    expect(errors(issues)).toEqual([]);
    expect(codes(issues)).toContain("media_will_downscale");
  });

  it("allows 8,000,000 bytes and notes 8,000,001 as compression", () => {
    expect(codes(run("x", [img({ bytes: 8_000_000 })]))).toEqual([]);
    const issues = run("x", [img({ bytes: 8_000_001 })]);
    expect(errors(issues)).toEqual([]);
    expect(codes(issues)).toContain("media_will_compress");
    expect(codes(issues)).not.toContain("file_too_large");
  });

  it("allows aspect 10:1 and 1:10 inclusive and blocks just beyond", () => {
    expect(errors(run("x", [img({ width: 1000, height: 100 })]))).toEqual([]);
    expect(errors(run("x", [img({ width: 1000, height: 10_000 })]))).toEqual([]);
    expect(errors(run("x", [img({ width: 1000, height: 99 })]))).toContain("aspect_ratio_out_of_range");
    expect(errors(run("x", [img({ width: 1000, height: 10_001 })]))).toContain("aspect_ratio_out_of_range");
  });

  it("allows alt text of 1000 and rejects 1001", () => {
    expect(codes(run("x", [img({ altText: "a".repeat(1000) })]))).not.toContain("alt_text_too_long");
    expect(codes(run("x", [img({ altText: "a".repeat(1001) })]))).toContain("alt_text_too_long");
  });

  it("accepts PNG as is and notes a conversion for WebP, GIF and HEIC", () => {
    expect(codes(run("x", [img({ mimeType: "image/png" })]))).toEqual([]);
    for (const mimeType of ["image/webp", "image/gif", "image/heic"]) {
      const issues = run("x", [img({ mimeType })]);
      expect(errors(issues), mimeType).toEqual([]);
      expect(codes(issues), mimeType).toContain("media_will_convert");
    }
  });
});
