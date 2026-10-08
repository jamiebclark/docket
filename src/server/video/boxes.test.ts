import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { indexAtFront, indexAtFrontOf } from "./boxes";

/** A box: 32-bit size, 4-character type, payload. */
function box(type: string, payload = 0, size?: number): Uint8Array {
  const total = size ?? 8 + payload;
  const out = new Uint8Array(Math.max(8, 8 + payload));
  new DataView(out.buffer).setUint32(0, total);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  return out;
}
/** A box with a 64-bit `largesize` header (size field 1). */
function bigBox(type: string, payload: number): Uint8Array {
  const out = new Uint8Array(16 + payload);
  const view = new DataView(out.buffer);
  view.setUint32(0, 1);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  view.setBigUint64(8, BigInt(16 + payload));
  return out;
}
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const walk = (bytes: Uint8Array) => indexAtFrontOf(async (offset, length) => bytes.subarray(offset, offset + length), bytes.length);

describe("indexAtFrontOf", () => {
  it("is true when moov precedes mdat", () => expect(walk(concat(box("ftyp", 12), box("moov", 100), box("mdat", 500)))).resolves.toBe(true));
  it("is false when mdat comes first (index at the end)", () => expect(walk(concat(box("ftyp", 12), box("mdat", 500), box("moov", 100)))).resolves.toBe(false));
  it("skips boxes between ftyp and moov", () => expect(walk(concat(box("ftyp", 12), box("free", 40), box("wide", 0), box("moov", 10), box("mdat", 10)))).resolves.toBe(true));
  it("is false when moov is missing", () => expect(walk(concat(box("ftyp", 12), box("free", 4)))).resolves.toBe(false));
  it("steps over a 64-bit box", () => expect(walk(concat(box("ftyp", 12), bigBox("free", 40), box("moov", 10), box("mdat", 10)))).resolves.toBe(true));
  it("sees a 64-bit mdat before moov", () => expect(walk(concat(box("ftyp", 12), bigBox("mdat", 40), box("moov", 10)))).resolves.toBe(false));
  it("treats a size of 0 (to end of file) as the last box", () => expect(walk(concat(box("ftyp", 12), box("free", 4, 0)))).resolves.toBe(false));
  it("is null for an empty file", () => expect(walk(new Uint8Array(0))).resolves.toBeNull());
  it("is null for bytes that are not boxes", () => expect(walk(new Uint8Array(64).fill(0xff))).resolves.toBeNull());
  it("is false for a truncated header after a good box", () => expect(walk(concat(box("ftyp", 12), new Uint8Array([0, 0, 0])))).resolves.toBe(false));
  it("refuses a box smaller than its own header", () => expect(walk(concat(box("ftyp", 12), box("free", 0, 4), box("moov", 4)))).resolves.toBe(false));
  it("gives up after 64 headers rather than walking forever", async () => {
    const many = concat(...Array.from({ length: 80 }, () => box("free", 0)), box("moov", 4));
    await expect(walk(many)).resolves.toBe(false);
  });
});

describe("indexAtFront", () => {
  it("reads a file, and is null for a missing one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "docket-boxes-"));
    try {
      await writeFile(join(dir, "front.mp4"), concat(box("ftyp", 12), box("moov", 10), box("mdat", 10)));
      await writeFile(join(dir, "end.mp4"), concat(box("ftyp", 12), box("mdat", 10), box("moov", 10)));
      expect(await indexAtFront(join(dir, "front.mp4"))).toBe(true);
      expect(await indexAtFront(join(dir, "end.mp4"))).toBe(false);
      expect(await indexAtFront(join(dir, "missing.mp4"))).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
