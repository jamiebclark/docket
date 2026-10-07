import { describe, expect, it } from "vitest";
import { mediaConstraintsOf, planImage, type MediaConstraints } from "./media";
import type { ProviderCapabilities } from "./types";

const baseCaps = (media: Partial<ProviderCapabilities["media"]>): ProviderCapabilities => ({
  text: { maxLength: 100, countingRule: "graphemes" },
  media: { maxImages: 4, allowedMimeTypes: ["image/jpeg"], maxBytesPerFile: 1000, required: false, ...media },
  video: { maxVideos: 0 },
  textOnlyAllowed: true,
  postTypes: ["text", "image"],
});

const instagram: MediaConstraints = mediaConstraintsOf(
  baseCaps({
    maxBytesPerFile: 8_000_000,
    minWidth: 320,
    maxWidth: 1440,
    minAspectRatio: 0.8,
    maxAspectRatio: 1.91,
    maxAltTextLength: 1000,
  }),
);
const bluesky = mediaConstraintsOf(
  baseCaps({ allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"], outputMimeType: "image/jpeg", maxBytesPerFile: 2_000_000 }),
);
const ctx = { index: 1, platform: "Instagram" };
const img = (o: Partial<{ mimeType: string; width: number; height: number; bytes: number }> = {}) => ({
  mimeType: "image/jpeg",
  width: 1080,
  height: 1080,
  bytes: 500_000,
  ...o,
});

describe("planImage", () => {
  it("passes a compliant image as is", () => {
    expect(planImage(img(), instagram, ctx)).toEqual({ kind: "original" });
  });
  it("converts a disallowed type", () => {
    const p = planImage(img({ mimeType: "image/png" }), instagram, ctx);
    expect(p).toMatchObject({ kind: "derive", steps: ["convert"], output: { mimeType: "image/jpeg", width: 1080 } });
    if (p.kind === "derive") expect(p.notes[0]).toMatchObject({ severity: "info", code: "media_will_convert", field: "media.1" });
  });
  it("rewords messages with a custom label and leaves decisions identical", () => {
    const base = planImage(img({ mimeType: "image/png" }), instagram, ctx);
    const labelled = planImage(img({ mimeType: "image/png" }), instagram, { ...ctx, label: "This image" });
    if (base.kind !== "derive" || labelled.kind !== "derive") throw new Error("expected derive");
    expect(labelled.steps).toEqual(base.steps);
    expect(labelled.output).toEqual(base.output);
    expect(labelled.notes[0]?.message).toMatch(/^This image /);
    expect(base.notes[0]?.message).toMatch(/^Image 2 /);
  });
  it("keeps an accepted type when only resizing", () => {
    const p = planImage(img({ width: 3000, height: 3000 }), instagram, ctx);
    expect(p).toMatchObject({ kind: "derive", steps: ["downscale"], output: { mimeType: "image/jpeg", width: 1440, height: 1440 } });
  });
  it("compresses an oversize file", () => {
    const p = planImage(img({ bytes: 9_000_000 }), instagram, ctx);
    expect(p).toMatchObject({ kind: "derive", steps: ["compress"], output: { maxBytes: 8_000_000 } });
  });
  it("converts an oversize PNG even when PNG is accepted", () => {
    const p = planImage(img({ mimeType: "image/png", bytes: 3_000_000 }), bluesky, ctx);
    expect(p).toMatchObject({ kind: "derive", steps: ["convert", "compress"], output: { mimeType: "image/jpeg" } });
  });
  it("orders convert, downscale, compress", () => {
    const p = planImage(img({ mimeType: "image/png", width: 3000, height: 2400, bytes: 9_000_000 }), instagram, ctx);
    expect(p.kind === "derive" && p.steps).toEqual(["convert", "downscale", "compress"]);
  });
  it("never upscales", () => {
    const p = planImage(img({ mimeType: "image/png", width: 400, height: 400 }), instagram, ctx);
    expect(p.kind === "derive" && p.output).toMatchObject({ width: 400, height: 400 });
  });
  it("refuses aspect ratios outside the range, wording the image number", () => {
    for (const [w, h] of [[2000, 1000], [1000, 2000]] as const) {
      const p = planImage(img({ width: w, height: h }), instagram, ctx);
      expect(p.kind).toBe("refuse");
      if (p.kind === "refuse") {
        expect(p.issues[0]).toMatchObject({ severity: "error", code: "aspect_ratio_out_of_range" });
        expect(p.issues[0]!.message).toContain("Image 2");
      }
    }
  });
  it("refuses an image smaller than the minimum", () => {
    const p = planImage(img({ width: 300, height: 300 }), instagram, ctx);
    expect(p).toMatchObject({ kind: "refuse", issues: [{ code: "image_too_small" }] });
  });
  it("refuses when downscaling would cross a minimum", () => {
    const c = mediaConstraintsOf(baseCaps({ minHeight: 500, maxWidth: 1000 }));
    const p = planImage(img({ width: 4000, height: 1000 }), c, ctx);
    expect(p).toMatchObject({ kind: "refuse", issues: [{ code: "image_too_small" }] });
  });
  it("accepts anything within the unconstrained bluesky-like rules", () => {
    expect(planImage(img({ mimeType: "image/webp", width: 9000, height: 100 }), bluesky, ctx)).toEqual({ kind: "original" });
  });
});

describe("mediaConstraintsOf", () => {
  it("defaults the output type to the first allowed type", () => {
    expect(instagram.outputMimeType).toBe("image/jpeg");
  });
  it("throws on inconsistent declarations", () => {
    expect(() => mediaConstraintsOf(baseCaps({ outputMimeType: "image/png" }))).toThrow(/outputMimeType/);
    expect(() => mediaConstraintsOf(baseCaps({ allowedMimeTypes: ["image/gif"] }))).toThrow(/cannot be produced/);
    expect(() => mediaConstraintsOf(baseCaps({ minWidth: 10, maxWidth: 5 }))).toThrow(/minWidth/);
    expect(() => mediaConstraintsOf(baseCaps({ maxBytesPerFile: 0 }))).toThrow(/maxBytesPerFile/);
  });
  it("allows a provider with no image support", () => {
    expect(() => mediaConstraintsOf(baseCaps({ maxImages: 0, allowedMimeTypes: [], maxBytesPerFile: 0 }))).not.toThrow();
  });
});
