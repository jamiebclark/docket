import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { mediaConstraintsOf, planImage, type MediaConstraints } from "../../providers/media";
import { blueskyLikeProvider, instagramLikeProvider } from "../../../tests/helpers/provider-fixtures";
import { jpeg, noisePng, png, jpegWithExif } from "../../../tests/helpers/images";
import { constraintsHash } from "./hash";
import { generateVariant } from "./variants";

const insta = mediaConstraintsOf(instagramLikeProvider.capabilities);
const bsky = mediaConstraintsOf(blueskyLikeProvider.capabilities);

async function derive(buf: Buffer, c: MediaConstraints) {
  const m = await sharp(buf).metadata();
  const plan = planImage({ mimeType: `image/${m.format}`, width: m.width!, height: m.height!, bytes: buf.length }, c, { index: 0, platform: "Test" });
  if (plan.kind !== "derive") throw new Error(`expected derive, got ${plan.kind}`);
  return { plan, result: await generateVariant(buf, plan, c) };
}

describe("generateVariant", () => {
  it("converts PNG to JPEG and downscales to the Instagram rules (SC-004)", async () => {
    const { result } = await derive(await png(3000, 2400), insta);
    if (!result.ok) throw new Error(result.message);
    const meta = await sharp(result.body).metadata();
    expect(meta.format).toBe("jpeg");
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.width).toBeLessThanOrEqual(1440);
    expect(result.width).toBeGreaterThanOrEqual(320);
    expect(result.bytes).toBeLessThanOrEqual(8_000_000);
    expect(Math.abs(result.width / result.height - 3000 / 2400)).toBeLessThan(0.01);
    expect(meta.exif).toBeUndefined();
    expect(meta.space).toBe("srgb");
  });

  it("compresses a noisy 4000×3000 PNG to ≤ 2,000,000 bytes as JPEG (Bluesky)", async () => {
    const started = Date.now();
    const { result } = await derive(await noisePng(4000, 3000), bsky);
    if (!result.ok) throw new Error(result.message);
    expect(result.bytes).toBeLessThanOrEqual(2_000_000);
    expect((await sharp(result.body).metadata()).format).toBe("jpeg");
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);

  it("never upscales", async () => {
    const { result } = await derive(await png(400, 400), insta);
    if (!result.ok) throw new Error(result.message);
    expect([result.width, result.height]).toEqual([400, 400]);
  });

  it("drops EXIF from derived output", async () => {
    const input = await jpegWithExif(2000, 1500, 1);
    const c = { ...insta, maxWidth: 1000 };
    const { result } = await derive(input, c);
    if (!result.ok) throw new Error(result.message);
    expect((await sharp(result.body).metadata()).exif).toBeUndefined();
  });

  it("fails with a message when the byte target cannot be reached", async () => {
    const c: MediaConstraints = { ...bsky, maxBytes: 20_000, minWidth: 1000 };
    const { result } = await derive(await noisePng(2000, 1500), c);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.message).toContain("20,000");
  }, 30_000);
});

describe("constraintsHash", () => {
  it("is stable and changes with any constraint", () => {
    expect(constraintsHash(insta)).toBe(constraintsHash({ ...insta }));
    expect(constraintsHash(insta)).not.toBe(constraintsHash({ ...insta, maxBytes: 7_000_000 }));
    expect(constraintsHash(insta)).not.toBe(constraintsHash({ ...insta, maxWidth: 1000 }));
    expect(constraintsHash(insta)).not.toBe(constraintsHash(bsky));
  });
  it("ignores alt-text length, which does not affect the bytes", async () => {
    expect(constraintsHash(insta)).toBe(constraintsHash({ ...insta, maxAltTextLength: 5 }));
    void jpeg;
  });
});
