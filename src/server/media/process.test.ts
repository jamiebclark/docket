import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  CAMERA_MAKE,
  animatedWebp,
  corruptBytes,
  gif,
  htmlAsJpg,
  jpeg,
  jpegWithExif,
  oversizePixels,
  png,
  svgAsJpg,
  truncatedJpeg,
  webp,
} from "../../../tests/helpers/images";
import { processUpload } from "./process";

const limits = { maxBytes: 20 * 1_048_576, maxPixels: 50_000_000 };

describe("processUpload", () => {
  it("auto-orients, strips EXIF/GPS and reports upright dimensions (SC-003)", async () => {
    const input = await jpegWithExif(200, 100, 6);
    expect(input.includes(Buffer.from(CAMERA_MAKE))).toBe(true);
    const r = await processUpload(input, limits);
    if (!r.ok) throw new Error(r.message);
    expect([r.original.width, r.original.height]).toEqual([100, 200]);
    expect(r.original.mimeType).toBe("image/jpeg");
    expect(r.original.body.includes(Buffer.from(CAMERA_MAKE))).toBe(false);
    expect(r.original.body.includes(Buffer.from("GPS"))).toBe(false);
    const meta = await sharp(r.original.body).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation ?? 1).toBe(1);
    expect(r.original.bytes).toBe(r.original.body.length);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])("handles orientation flag %i", async (o) => {
    const r = await processUpload(await jpegWithExif(200, 100, o), limits);
    if (!r.ok) throw new Error(r.message);
    const swapped = o >= 5;
    expect([r.original.width, r.original.height]).toEqual(swapped ? [100, 200] : [200, 100]);
  });

  it("makes a WebP thumbnail no larger than 480 px", async () => {
    const r = await processUpload(await jpeg(1600, 800), limits);
    if (!r.ok) throw new Error(r.message);
    expect((await sharp(r.thumbnail.body).metadata()).format).toBe("webp");
    expect(r.thumbnail.width).toBe(480);
    expect(r.thumbnail.height).toBe(240);
  });

  it("accepts PNG and WebP", async () => {
    const p = await processUpload(await png(), limits);
    const w = await processUpload(await webp(), limits);
    expect(p).toMatchObject({ ok: true, original: { mimeType: "image/png", ext: "png" } });
    expect(w).toMatchObject({ ok: true, original: { mimeType: "image/webp", ext: "webp" } });
  });

  it("rejects an over-size buffer before decoding", async () => {
    expect(await processUpload(Buffer.alloc(21 * 1_048_576), limits)).toMatchObject({ ok: false, code: "too_large" });
  });

  it("rejects non-images and broken files as unreadable", async () => {
    for (const b of [corruptBytes(), htmlAsJpg(), await truncatedJpeg()]) {
      expect(await processUpload(b, limits)).toMatchObject({ ok: false, code: "unreadable" });
    }
  });

  it("rejects GIF and SVG as unsupported", async () => {
    expect(await processUpload(await gif(), limits)).toMatchObject({ ok: false, code: "unsupported_type" });
    expect(await processUpload(svgAsJpg(), limits)).toMatchObject({ ok: false, code: "unsupported_type" });
  });

  it("rejects animated WebP", async () => {
    expect(await processUpload(await animatedWebp(), limits)).toMatchObject({ ok: false, code: "animated" });
  });

  it("rejects images over the pixel limit", async () => {
    const big = await oversizePixels(1_000_000);
    expect(await processUpload(big, { ...limits, maxPixels: 1_000_000 })).toMatchObject({ ok: false, code: "too_many_pixels" });
  });
});
