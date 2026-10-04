import { describe, expect, it } from "vitest";
import type { MediaItem } from "../types";
import { blueskyProvider } from "./index";
import { validateBluesky } from "./validate";

const caps = blueskyProvider.capabilities;
const image = (over: Partial<MediaItem> = {}): MediaItem => ({
  url: "https://media.example.test/a.jpg",
  mimeType: "image/jpeg",
  width: 800,
  height: 600,
  bytes: 1000,
  altText: "alt",
  ...over,
});
const run = (text: string, media: MediaItem[] = []) => validateBluesky({ text, media }, caps);
const codes = (text: string, media: MediaItem[] = []) => run(text, media).map((i) => i.code);

const FAMILY = "👨‍👩‍👧‍👦"; // 1 grapheme, 25 bytes
const SKIN = "👍🏽"; // 1 grapheme
const FLAG = "🇯🇵"; // 1 grapheme
const COMBINED = "é"; // 1 grapheme

describe("validateBluesky text length", () => {
  it.each([
    ["ZWJ families", FAMILY],
    ["skin tones", SKIN],
    ["flags", FLAG],
    ["combining marks", COMBINED],
  ])("counts %s as one grapheme: 300 passes, 301 fails", (_name, unit) => {
    expect(codes(unit.repeat(300))).not.toContain("text_too_long");
    const over = run(unit.repeat(301)).find((i) => i.code === "text_too_long");
    expect(over).toMatchObject({ severity: "error", count: 301, limit: 300 });
  });
});

describe("validateBluesky byte limit", () => {
  it("allows exactly 3,000 bytes", () => {
    const text = FAMILY.repeat(120);
    expect(Buffer.byteLength(text)).toBe(3000);
    expect(codes(text)).not.toContain("text_too_many_bytes");
  });

  it("blocks 3,001 bytes even when graphemes are under the limit", () => {
    const text = FAMILY.repeat(120) + "a";
    const issue = run(text).find((i) => i.code === "text_too_many_bytes");
    expect(issue).toMatchObject({ severity: "error", field: "text", count: 3001, limit: 3000 });
    expect(codes(text)).not.toContain("text_too_long");
  });
});

describe("validateBluesky media", () => {
  it("allows 4 images and blocks 5", () => {
    expect(codes("hi", Array.from({ length: 4 }, () => image()))).not.toContain("too_many_images");
    const issue = run("hi", Array.from({ length: 5 }, () => image())).find((i) => i.code === "too_many_images");
    expect(issue).toMatchObject({ severity: "error", count: 5, limit: 4 });
  });

  it("allows 2,000,000 bytes and blocks 2,000,001", () => {
    expect(codes("hi", [image({ bytes: 2_000_000 })])).not.toContain("file_too_large");
    const issue = run("hi", [image({ bytes: 2_000_001 })]).find((i) => i.code === "file_too_large");
    expect(issue).toMatchObject({ severity: "error", field: "media.0", count: 2_000_001, limit: 2_000_000 });
  });

  it("blocks an image type Bluesky cannot take", () => {
    expect(run("hi", [image({ mimeType: "image/webp" })])).toContainEqual(
      expect.objectContaining({ code: "mime_not_allowed", severity: "error" }),
    );
  });
});

describe("validateBluesky shape", () => {
  it("accepts a text-only post", () => {
    expect(run("just words").filter((i) => i.severity === "error")).toEqual([]);
  });

  it("reports empty_post for no text and no media", () => {
    expect(run("   ")).toContainEqual(expect.objectContaining({ code: "empty_post", severity: "error" }));
  });

  it("accepts an image-only post", () => {
    expect(run("", [image()]).filter((i) => i.severity === "error")).toEqual([]);
  });
});
