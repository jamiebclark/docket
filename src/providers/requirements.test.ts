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
      const v = c.video;
      expect(r.video.maxVideos, p.key).toBe(v.maxVideos);
      expect(r.video.containers.map((x) => x.value), p.key).toEqual([...(v.containers ?? [])]);
      expect(r.video.maxBytes?.value ?? null, p.key).toBe(v.maxBytes ?? null);
      expect(r.video.duration.min?.value ?? null, p.key).toBe(v.minDurationSeconds ?? null);
      expect(r.video.duration.max?.value ?? null, p.key).toBe(v.maxDurationSeconds ?? null);
      expect(r.video.maxFrameRate?.value ?? null, p.key).toBe(v.maxFrameRate ?? null);
      expect(r.video.silentAllowed, p.key).toBe(v.silentAllowed ?? true);
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

  it("says video is not accepted for every provider that declares maxVideos 0", () => {
    for (const p of listProviders().filter((x) => x.capabilities.video.maxVideos === 0)) {
      const r = requirementsOf(p.capabilities, { uploadTypes });
      expect(r.video, p.key).toMatchObject({ maxVideos: 0, containers: [], maxBytes: null, maxFrameRate: null });
    }
  });

  it("describes Threads' video limits from its declaration (data-model §7)", () => {
    const r = requirementsOf(findProvider("threads")!.capabilities, { uploadTypes });
    const v = r.video;
    expect(v.postType).toBeNull();
    expect(v.maxVideos).toBe(1);
    expect(v.withImages).toBe(false);
    expect(v.containers.map((c) => c.label)).toEqual(["MP4", "MOV"]);
    expect(v.videoCodecs.map((c) => c.label)).toEqual(["H.264", "HEVC"]);
    expect(v.audioCodecs.map((c) => c.label)).toEqual(["AAC"]);
    expect(v.maxBytes?.label).toBe("1 GB");
    expect(v.duration.max?.label).toBe("5 minutes");
    expect(v.width.max?.label).toBe("1920 px");
    expect(v.aspectRatio.min?.label).toBe("1:100");
    expect(v.aspectRatio.max?.label).toBe("10:1");
    expect(v.minFrameRate?.label).toBe("23 fps");
    expect(v.maxFrameRate?.label).toBe("60 fps");
    expect(v.notes).toEqual(["9:16 (vertical) is recommended."]);
    expect(r.carousel).toMatchObject({
      maxItems: 20,
      mixed: true,
      notes: ["A carousel holds 2 to 20 items, images and videos counted together."],
    });
    expect(r.carousel?.videoAspectRatio.min?.label).toBe("1:100");
    expect(r.carousel?.videoAspectRatio.max?.label).toBe("10:1");
  });

  it("describes the mock's video limits with labels", () => {
    const r = requirementsOf(findProvider("mock")!.capabilities, { uploadTypes }).video;
    expect(r.maxVideos).toBe(1);
    expect(r.containers.map((c) => c.label)).toEqual(["MP4", "MOV"]);
    expect(r.videoCodecs.map((c) => c.label)).toEqual(["H.264"]);
    expect(r.audioCodecs.map((c) => c.label)).toEqual(["AAC"]);
    expect(r.maxBytes?.label).toBe("50 MB");
    expect(r.duration.min?.label).toBe("1 second");
    expect(r.duration.max?.label).toBe("1 minute");
    expect(r.aspectRatio.min?.label).toBe("9:16");
    expect(r.aspectRatio.max?.label).toBe("16:9");
    expect(r.maxFrameRate?.label).toBe("60 fps");
    expect(r.withImages).toBe(false);
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

  describe("Instagram video (P13)", () => {
    const ig = findProvider("instagram")!.capabilities;

    it("shows Feed video by default, with Reel limits and a frame-rate range", () => {
      const v = requirementsOf(ig, { uploadTypes }).video;
      expect(v.postType).toEqual({ value: "video", label: "Feed video", description: expect.any(String) });
      expect(v.minFrameRate?.label).toBe("23 fps");
      expect(v.maxFrameRate?.label).toBe("60 fps");
      expect(v.maxBytes?.label).toBe("300 MB");
      expect(v.duration.min?.label).toBe("3 seconds");
      expect(v.aspectRatio.min?.label).toBe("1:100");
      expect(v.aspectRatio.max?.label).toBe("10:1");
    });

    it("follows the chosen type: reel, then carousel", () => {
      const reel = requirementsOf(ig, { uploadTypes, postType: "reel" }).video;
      expect(reel.postType).toMatchObject({ value: "reel", label: "Reel", description: "Shown in the Reels tab only." });
      const car = requirementsOf(ig, { uploadTypes, postType: "carousel" }).video;
      expect(car.postType).toEqual({ value: "carousel", label: "carousel item", description: null });
      expect(car.maxVideos).toBe(10);
      expect(car.withImages).toBe(true);
      expect(car.aspectRatio.min?.label).toBe("4:5");
      expect(car.aspectRatio.max?.label).toBe("1.91:1");
      expect(car.notes).toEqual(["Reels cannot be carousel items."]);
    });

    it("ignores a type that is not an option and falls back to the default", () => {
      expect(requirementsOf(ig, { uploadTypes, postType: "image" }).video.postType?.value).toBe("video");
    });

    it("describes the carousel", () => {
      expect(requirementsOf(ig, { uploadTypes }).carousel).toMatchObject({
        maxItems: 10,
        mixed: true,
        notes: ["Reels cannot be carousel items."],
      });
    });

    it("pins one Instagram summary note list per type", () => {
      const notes = (postType: "video" | "reel" | "carousel") => requirementsOf(ig, { uploadTypes, postType }).video.notes;
      expect(notes("video")).toEqual([]);
      expect(notes("reel")).toEqual([]);
      expect(notes("carousel")).toEqual(["Reels cannot be carousel items."]);
    });

    it("shows the notes of any shown type, not only carousel", () => {
      const caps: ProviderCapabilities = {
        ...ig,
        video: { ...ig.video, byPostType: { ...ig.video.byPostType, reel: { ...ig.video.byPostType?.reel, notes: ["Vertical only."] } } },
      };
      expect(requirementsOf(caps, { uploadTypes, postType: "reel" }).video.notes).toEqual(["Vertical only."]);
      expect(requirementsOf(caps, { uploadTypes, postType: "video" }).video.notes).toEqual([]);
    });

    it("shows no post type for per-type limits without a choice (P2)", () => {
      const caps: ProviderCapabilities = {
        ...findProvider("mock")!.capabilities,
        video: { maxVideos: 1, byPostType: { video: { notes: ["Vertical is best."] } } },
        postTypes: ["text", "image", "video"],
      };
      const r = requirementsOf(caps, { uploadTypes });
      expect(r.video.postType).toBeNull();
      expect(r.video.notes).toEqual(["Vertical is best."]);
    });

    it("keeps one Instagram and one Facebook post type per shown type", () => {
      for (const key of ["instagram", "facebook"]) {
        const caps = findProvider(key)!.capabilities;
        for (const type of caps.postTypeChoices!.flatMap((c) => c.options.map((o) => o.type))) {
          expect(requirementsOf(caps, { uploadTypes, postType: type }).video.postType?.value, `${key} ${type}`).toBe(type);
        }
      }
    });

    it("leaves providers without choices or per-type limits unchanged", () => {
      for (const key of ["mock", "bluesky", "x"]) {
        const r = requirementsOf(findProvider(key)!.capabilities, { uploadTypes });
        expect(r.carousel, key).toBeNull();
        expect(r.video.postType, key).toBeNull();
        expect(r.video.notes, key).toEqual([]);
        expect(r.video.minFrameRate, key).toBeNull();
      }
    });
  });
});
