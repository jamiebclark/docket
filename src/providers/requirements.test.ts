import { describe, expect, it } from "vitest";
import { UPLOAD_MIME_TYPES } from "@/lib/media/types";
import { aspectLabel, bytesLabel, requirementsOf } from "./requirements";
import { countingRuleName, countingUnit } from "./text";
import { listProviders, findProvider } from "./registry";
import type { ProviderCapabilities } from "./types";

const uploadTypes = UPLOAD_MIME_TYPES;

describe("requirementsOf", () => {
  it("equals each provider's capabilities, field by field (SC-001)", () => {
    for (const p of listProviders()) {
      const c = p.capabilities;
      const r = requirementsOf(c, { uploadTypes });
      expect(r.text, p.key).toEqual({
        maxLength: c.text.maxLength,
        countingRule: countingRuleName(c.text.countingRule),
        unit: countingUnit(c.text.countingRule),
        maxHashtags: c.text.maxHashtags ?? null,
        maxMentions: c.text.maxMentions ?? null,
      });
      expect(r.image.maxImages, p.key).toBe(c.media.maxImages);
      expect(r.image.formats.map((f) => f.value), p.key).toEqual([...c.media.allowedMimeTypes]);
      expect(r.image.maxBytesPerFile.value, p.key).toBe(c.media.maxBytesPerFile);
      expect(r.image.width.min?.value ?? null, p.key).toBe(c.media.minWidth ?? null);
      expect(r.image.width.max?.value ?? null, p.key).toBe(c.media.maxWidth ?? null);
      expect(r.image.height.min?.value ?? null, p.key).toBe(c.media.minHeight ?? null);
      expect(r.image.height.max?.value ?? null, p.key).toBe(c.media.maxHeight ?? null);
      expect(r.image.aspectRatio.min?.value ?? null, p.key).toBe(c.media.minAspectRatio ?? null);
      expect(r.image.aspectRatio.max?.value ?? null, p.key).toBe(c.media.maxAspectRatio ?? null);
      expect(r.image.maxAltTextLength, p.key).toBe(c.media.maxAltTextLength ?? null);
      expect(r.post).toEqual({ mediaRequired: c.media.required || !c.textOnlyAllowed, textOnlyAllowed: c.textOnlyAllowed, postTypes: [...c.postTypes] });
      expect(r, p.key).not.toHaveProperty("video");
      expect(r.image, p.key).not.toHaveProperty("video");
    }
  });

  it("matches the documented table for the real providers (data-model §3)", () => {
    const of = (key: string) => requirementsOf(findProvider(key)!.capabilities, { uploadTypes });
    const labels = (xs: { label: string }[]) => xs.map((x) => x.label);

    const ig = of("instagram");
    expect(ig.text).toMatchObject({ maxLength: 2200, unit: "characters", maxHashtags: 30, maxMentions: 20 });
    expect(ig.image.maxImages).toBe(10);
    expect(labels(ig.image.formats)).toEqual(["JPEG"]);
    expect(ig.image.convertedTo?.label).toBe("JPEG");
    expect(labels(ig.image.convertedFrom)).toEqual(["PNG", "WebP"]);
    expect(ig.image.maxBytesPerFile.label).toBe("8 MB");
    expect(ig.image.width.min?.label).toBe("320 px");
    expect(ig.image.width.max?.label).toBe("1440 px");
    expect(ig.image.aspectRatio.min?.label).toBe("4:5");
    expect(ig.image.aspectRatio.max?.label).toBe("1.91:1");
    expect(ig.image.maxAltTextLength).toBe(1000);
    expect(ig.post).toMatchObject({ mediaRequired: true, textOnlyAllowed: false });

    const fb = of("facebook");
    expect(fb.text).toMatchObject({ maxLength: 10000, maxHashtags: null, maxMentions: null });
    expect(fb.image.maxImages).toBe(10);
    expect(labels(fb.image.formats)).toEqual(["JPEG", "PNG"]);
    expect(labels(fb.image.convertedFrom)).toEqual(["WebP"]);
    expect(fb.image.maxBytesPerFile.label).toBe("10 MB");
    expect(fb.image.width).toEqual({ min: null, max: null });
    expect(fb.image.maxAltTextLength).toBeNull();
    expect(fb.post).toMatchObject({ mediaRequired: false, textOnlyAllowed: true });

    const th = of("threads");
    expect(th.text.maxLength).toBe(500);
    expect(th.image.maxImages).toBe(20);
    expect(th.image.aspectRatio.min?.label).toBe("1:10");
    expect(th.image.aspectRatio.max?.label).toBe("10:1");

    const bs = of("bluesky");
    expect(bs.text).toMatchObject({ maxLength: 300, unit: "graphemes" });
    expect(bs.image.maxImages).toBe(4);
    expect(bs.image.maxBytesPerFile.label).toBe("2 MB");
    expect(bs.image.aspectRatio).toEqual({ min: null, max: null });
    expect(bs.image.maxAltTextLength).toBeNull();

    const x = of("x");
    expect(x.text.maxLength).toBe(280);
    expect(x.image.maxImages).toBe(4);
    expect(labels(x.image.formats)).toEqual(["JPEG", "PNG", "WebP"]);
    expect(x.image.convertedFrom).toEqual([]);
    expect(x.image.maxBytesPerFile.label).toBe("5 MB");
    expect(x.image.maxAltTextLength).toBe(1000);
  });

  it("follows the capabilities: changing a value changes the summary (FR-003)", () => {
    const base = findProvider("bluesky")!.capabilities;
    const changed: ProviderCapabilities = {
      ...base,
      text: { ...base.text, maxLength: 123, maxHashtags: 7 },
      media: { ...base.media, maxImages: 2, maxBytesPerFile: 1_500_000, minWidth: 100 },
    };
    const r = requirementsOf(changed, { uploadTypes });
    expect(r.text).toMatchObject({ maxLength: 123, maxHashtags: 7 });
    expect(r.image.maxImages).toBe(2);
    expect(r.image.maxBytesPerFile.label).toBe("1.5 MB");
    expect(r.image.width.min).toEqual({ value: 100, label: "100 px" });
  });

  it("has no output type or conversions when images are not accepted", () => {
    const base = findProvider("bluesky")!.capabilities;
    const r = requirementsOf({ ...base, media: { ...base.media, maxImages: 0, allowedMimeTypes: [] } }, { uploadTypes });
    expect(r.image.convertedTo).toBeNull();
    expect(r.image.convertedFrom).toEqual([]);
  });
});

describe("label helpers", () => {
  it("aspectLabel", () => {
    expect(aspectLabel(0.8)).toBe("4:5");
    expect(aspectLabel(1.91)).toBe("1.91:1");
    expect(aspectLabel(0.1)).toBe("1:10");
    expect(aspectLabel(10)).toBe("10:1");
  });
  it("bytesLabel", () => {
    expect(bytesLabel(8_000_000)).toBe("8 MB");
    expect(bytesLabel(2_000_000)).toBe("2 MB");
    expect(bytesLabel(1_500_000)).toBe("1.5 MB");
  });
});
