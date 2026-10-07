import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createVideoFixtures, ftyp, type VideoFixtures } from "../../../tests/helpers/video-fixtures";
import { requireFfmpeg } from "../../../tests/helpers/ffmpeg";
import { sniffMedia } from "./sniff";

const head = (path: string) => new Uint8Array(readFileSync(path).subarray(0, 64));

describe("sniffMedia: images", () => {
  it.each([
    ["jpeg", "image/jpeg"],
    ["png", "image/png"],
    ["webp", "image/webp"],
  ] as const)("recognises %s from sharp output", async (format, mimeType) => {
    const buf = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#369" } })
      [format]()
      .toBuffer();
    expect(sniffMedia(new Uint8Array(buf.subarray(0, 64)))).toEqual({ kind: "image", mimeType });
  });
});

describe("sniffMedia: containers by brand", () => {
  it("reads mp4 and mov from the ftyp major brand", () => {
    expect(sniffMedia(ftyp("isom"))).toEqual({ kind: "video", mimeType: "video/mp4", container: "mp4" });
    expect(sniffMedia(ftyp("mp42"))).toEqual({ kind: "video", mimeType: "video/mp4", container: "mp4" });
    expect(sniffMedia(ftyp("qt  "))).toEqual({ kind: "video", mimeType: "video/quicktime", container: "mov" });
  });

  it("reads legacy QuickTime without ftyp", () => {
    const b = Buffer.alloc(16);
    b.writeUInt32BE(16, 0);
    b.write("moov", 4, "ascii");
    expect(sniffMedia(b)?.container).toBe("mov");
  });

  it("refuses an M4A, a HEIC, a PDF, short input and random bytes", () => {
    expect(sniffMedia(ftyp("M4A "))).toBeNull();
    expect(sniffMedia(ftyp("heic"))).toBeNull();
    expect(sniffMedia(new TextEncoder().encode("%PDF-1.7\n%âãÏÓ\n1 0 obj"))).toBeNull();
    expect(sniffMedia(new Uint8Array([0xff, 0xd8]))).toBeNull();
    expect(sniffMedia(new Uint8Array(0))).toBeNull();
    expect(sniffMedia(new Uint8Array(randomBytes(64).map((v) => (v === 0x66 ? 0 : v))))).toBeNull();
  });
});

requireFfmpeg()("sniffMedia: ffmpeg-generated files", () => {
  let fx: VideoFixtures;
  beforeAll(() => {
    fx = createVideoFixtures();
  });
  afterAll(() => fx?.cleanup());

  it("recognises an mp4 and a mov", () => {
    expect(sniffMedia(head(fx.landscape))).toMatchObject({ kind: "video", container: "mp4" });
    expect(sniffMedia(head(fx.mov))).toMatchObject({ kind: "video", container: "mov" });
  });

  it("refuses an audio-only m4a", () => {
    expect(sniffMedia(head(fx.audioOnly))).toBeNull();
  });
});
