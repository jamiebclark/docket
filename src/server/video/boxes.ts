import { open } from "node:fs/promises";

/** Most box headers read; a normal MP4 has `ftyp`, `moov` and `mdat` within the first few. */
const MAX_HEADERS = 64;

/**
 * Reads the box headers of a stream at the top level of an MP4/MOV file. `read(offset, length)` returns up to `length`
 * bytes at `offset` (fewer or none at the end of the file); `size` is the file's length.
 *
 * `true` when `moov` comes before the first `mdat`; `false` when `mdat` comes first or `moov` is missing; `null` when the
 * file cannot be read as boxes. Pure: it reads only headers, never box contents.
 */
export async function indexAtFrontOf(read: (offset: number, length: number) => Promise<Uint8Array>, size: number): Promise<boolean | null> {
  let offset = 0;
  let sawBox = false;
  for (let i = 0; i < MAX_HEADERS && offset < size; i++) {
    const head = await read(offset, 16);
    if (head.length < 8) return sawBox ? false : null;
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    let boxSize = view.getUint32(0);
    const type = String.fromCharCode(head[4]!, head[5]!, head[6]!, head[7]!);
    if (!/^[\x20-\x7e]{4}$/.test(type)) return sawBox ? false : null;
    sawBox = true;
    if (type === "moov") return true;
    if (type === "mdat") return false;
    if (boxSize === 1) {
      if (head.length < 16) return false;
      const big = view.getBigUint64(8);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) return false;
      boxSize = Number(big);
    } else if (boxSize === 0) {
      return false; // runs to the end of the file, and it is not moov or mdat
    }
    if (boxSize < 8) return false;
    offset += boxSize;
  }
  return sawBox ? false : null;
}

/** `true` when the file's index (`moov`) precedes its media data (`mdat`). `null` when it cannot be read. */
export async function indexAtFront(path: string): Promise<boolean | null> {
  let handle;
  try {
    handle = await open(path, "r");
    const { size } = await handle.stat();
    return await indexAtFrontOf(async (offset, length) => {
      const buffer = new Uint8Array(length);
      const { bytesRead } = await handle!.read(buffer, 0, length, offset);
      return buffer.subarray(0, bytesRead);
    }, size);
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}
