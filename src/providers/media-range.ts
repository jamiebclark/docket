/** Byte-range reads of stored media over its public URL (P6): never the whole file. */

export class MediaRangeError extends Error {
  constructor(
    message: string,
    readonly kind: "no_ranges" | "bad_reply" | "unavailable",
  ) {
    super(message);
  }
}

/** `Content-Range: bytes first-last/total` → total, or null. */
function totalOf(header: string | null): number | null {
  const m = /^bytes\s+\d+-\d+\/(\d+)$/i.exec((header ?? "").trim());
  return m ? Number(m[1]) : null;
}

/** Reads bytes `first..last` (inclusive). The reply must be a 206 of exactly that length; a 200 is cancelled unread. */
export async function readRange(url: string, first: number, last: number, signal: AbortSignal): Promise<{ bytes: Uint8Array; total: number }> {
  const res = await globalThis.fetch(url, { headers: { Range: `bytes=${first}-${last}` }, signal });
  if (res.status === 200) {
    await res.body?.cancel().catch(() => undefined);
    throw new MediaRangeError("The video's storage did not return the requested part (HTTP 200; byte ranges are needed); will retry.", "no_ranges");
  }
  if (res.status !== 206) {
    await res.body?.cancel().catch(() => undefined);
    throw new MediaRangeError(`The video's storage did not return the requested part (HTTP ${res.status}); will retry.`, "unavailable");
  }
  const total = totalOf(res.headers.get("content-range"));
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (total === null || bytes.length !== last - first + 1) throw new MediaRangeError("The video's storage returned an unexpected part; will retry.", "bad_reply");
  return { bytes, total };
}

/** The stored file's total size, read with `bytes=0-0`. */
export async function storedSize(url: string, signal: AbortSignal): Promise<number> {
  const { total } = await readRange(url, 0, 0, signal);
  return total;
}
