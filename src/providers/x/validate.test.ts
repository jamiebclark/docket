import { describe, expect, it } from "vitest";
import { xCapabilities as caps } from "./capabilities";
import { validateX } from "./validate";
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
const run = (text: string, media: MediaItem[] = []) => validateX({ text, media }, caps);
const codes = (issues: { code: string }[]) => issues.map((i) => i.code);
const errors = (issues: { severity: string; code: string }[]) => issues.filter((i) => i.severity === "error").map((i) => i.code);

describe("validateX", () => {
  it("allows 280 characters and blocks 281", () => {
    expect(codes(run("a".repeat(280)))).not.toContain("text_too_long");
    expect(run("a".repeat(281)).find((i) => i.code === "text_too_long")).toMatchObject({ severity: "error", count: 281, limit: 280 });
  });

  it("counts a long link as 23 and CJK as 2", () => {
    expect(codes(run("a".repeat(256) + " https://example.com/" + "p".repeat(80)))).not.toContain("text_too_long");
    expect(codes(run("日".repeat(140)))).not.toContain("text_too_long");
    expect(codes(run("日".repeat(141)))).toContain("text_too_long");
  });

  it("blocks an empty post, allows text only", () => {
    expect(codes(run(""))).toContain("empty_post");
    expect(errors(run("hello"))).toEqual([]);
  });

  it("refuses more than four images", () => {
    expect(errors(run("hi", Array.from({ length: 5 }, () => img())))).toContain("too_many_images");
    expect(errors(run("hi", Array.from({ length: 4 }, () => img())))).toEqual([]);
  });

  it("notes, not blocks, an image that will be converted or recompressed", () => {
    const issues = run("hi", [img({ mimeType: "image/gif" })]);
    expect(errors(issues)).toEqual([]);
    const big = run("hi", [img({ bytes: 6_000_000 })]);
    expect(errors(big)).toEqual([]);
  });

  it("blocks alt text over 1,000 characters", () => {
    expect(codes(run("hi", [img({ altText: "x".repeat(1001) })]))).toContain("alt_text_too_long");
  });

  it("warns near the limit when a link or emoji is present, and never blocks on it", () => {
    const withLink = run("a".repeat(250) + " example.com");
    const warn = withLink.find((i) => i.code === "x_count_may_differ");
    expect(warn).toMatchObject({ severity: "warning" });
    expect(errors(withLink)).toEqual([]);
    expect(codes(run("a".repeat(268) + " \u{1F600}"))).toContain("x_count_may_differ");
  });

  it("does not warn without a link or emoji, or below the threshold", () => {
    expect(codes(run("a".repeat(279)))).not.toContain("x_count_may_differ");
    expect(codes(run("see example.com"))).not.toContain("x_count_may_differ");
  });
});
