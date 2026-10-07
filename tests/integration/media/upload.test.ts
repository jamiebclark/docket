import sharp from "sharp";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);
vi.mock("next/cache", async () => (await import("../../helpers/actions")).cacheModule);
vi.mock("next/navigation", async () => (await import("../../helpers/actions")).navigationModule);

import * as media from "../../../src/server/services/media";
import { StorageUnavailableError, setStorageForTests } from "../../../src/server/storage";
import { closeDb } from "../../helpers/db";
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
} from "../../helpers/images";
import { postsEnv } from "../../helpers/posts-env";
import { createMemoryStorage } from "../../helpers/storage";

afterAll(async () => {
  setStorageForTests(undefined);
  await closeDb();
});
afterEach(() => setStorageForTests(undefined));

async function setup() {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  const env = await postsEnv();
  return { storage, ...env };
}

describe("uploadMedia", () => {
  it("accepts a PNG, stores original and thumbnail under the project prefix", async () => {
    const { storage, scope, project } = await setup();
    const res = await media.uploadMedia(scope, { file: { name: "../dir/photo.png", bytes: await png(800, 400) } });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.asset).toMatchObject({ mimeType: "image/png", width: 800, height: 400, originalFilename: "photo.png", missingAlt: true });
    const keys = [...storage.objects.keys()];
    expect(keys).toHaveLength(2);
    for (const k of keys) expect(k.startsWith(`projects/${project.id}/`)).toBe(true);
    expect(keys.some((k) => k.endsWith("/thumb.webp"))).toBe(true);
    expect((await sharp(storage.objects.get(keys.find((k) => k.endsWith("thumb.webp"))!)!.body).metadata()).format).toBe("webp");
  });

  it("strips EXIF/GPS and stores upright dimensions (SC-003)", async () => {
    const { storage, scope } = await setup();
    const res = await media.uploadMedia(scope, { file: { name: "cam.jpg", bytes: await jpegWithExif(200, 100, 6) } });
    expect(res.ok && res.asset).toMatchObject({ width: 100, height: 200, mimeType: "image/jpeg" });
    for (const { body } of storage.objects.values()) {
      expect(body.includes(Buffer.from(CAMERA_MAKE))).toBe(false);
      expect(body.includes(Buffer.from("GPS"))).toBe(false);
    }
  });

  it.each([
    ["renamed SVG", async () => svgAsJpg(), "unsupported_type"],
    ["renamed HTML", async () => htmlAsJpg(), "unreadable"],
    ["corrupt", async () => corruptBytes(), "unreadable"],
    ["GIF", () => gif(), "unsupported_type"],
    ["animated WebP", () => animatedWebp(), "animated"],
    ["too many pixels", () => oversizePixels(51_000_000), "too_many_pixels"],
    ["oversize", async () => Buffer.alloc(21 * 1024 * 1024, 1), "too_large"],
  ] as const)("rejects %s per file without storing anything", async (_n, make, code) => {
    const { storage, scope } = await setup();
    const res = await media.uploadMedia(scope, { file: { name: "x.jpg", bytes: await make() } });
    expect(res).toMatchObject({ ok: false, code });
    expect(storage.objects.size).toBe(0);
    expect((await media.listMedia(scope)).total).toBe(0);
  });

  it("rejects the sniffed type even when the name claims another", async () => {
    const { scope } = await setup();
    const res = await media.uploadMedia(scope, { file: { name: "really-a-jpeg.png", bytes: await jpeg() } });
    expect(res.ok && res.asset.mimeType).toBe("image/jpeg");
  });

  it("throws StorageUnavailableError when storage is off", async () => {
    const env = await postsEnv();
    setStorageForTests(null);
    await expect(media.uploadMedia(env.scope, { file: { name: "a.png", bytes: await png() } })).rejects.toBeInstanceOf(
      StorageUnavailableError,
    );
    expect((await media.mediaStatus(env.scope)).enabled).toBe(false);
  });

  it("removes both objects when the insert fails", async () => {
    const { storage, scope } = await setup();
    const failing = Object.create(scope, {
      transaction: { value: async () => { throw new Error("db down"); } },
    }) as typeof scope;
    await expect(media.uploadMedia(failing, { file: { name: "a.png", bytes: await png() } })).rejects.toThrow("db down");
    expect(storage.objects.size).toBe(0);
  });
});
