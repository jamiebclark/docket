import { sniffMedia } from "@/lib/media/sniff";
import type { LibraryLimits } from "@/server/media/limits";

export type PrecheckCode = "unsupported_type" | "too_large" | "too_long" | "too_big" | "no_video";

/** What the browser could read from a video's metadata. */
export interface VideoMeta {
  durationSeconds: number;
  width: number;
  height: number;
}

export interface PrecheckValues {
  size?: number;
  seconds?: number;
  side?: number;
  kind?: "image" | "video";
}

export type PrecheckResult =
  | { ok: true; kind: "image" | "video"; mimeType: string; checksAfterUpload: boolean }
  | { ok: false; code: PrecheckCode; values: PrecheckValues };

/**
 * The browser's checks, in a fixed order (P13): type by contents, size, then video metadata. `readVideo` resolves
 * to null when the browser could not read the file, which passes the file with `checksAfterUpload` (FR-005).
 */
export async function precheck(
  file: { size: number; head: Uint8Array },
  limits: LibraryLimits,
  readVideo: () => Promise<VideoMeta | null>,
): Promise<PrecheckResult> {
  const sniffed = file.size > 0 ? sniffMedia(file.head) : null;
  if (!sniffed || !limits[sniffed.kind].types.includes(sniffed.mimeType)) {
    return { ok: false, code: "unsupported_type", values: {} };
  }
  const rule = limits[sniffed.kind];
  if (file.size > rule.maxBytes) return { ok: false, code: "too_large", values: { size: file.size, kind: sniffed.kind } };
  if (sniffed.kind === "image") return { ok: true, kind: "image", mimeType: sniffed.mimeType, checksAfterUpload: false };

  const meta = await readVideo();
  if (!meta) return { ok: true, kind: "video", mimeType: sniffed.mimeType, checksAfterUpload: true };
  if (meta.width === 0) return { ok: false, code: "no_video", values: {} };
  if (meta.durationSeconds > limits.video.maxSeconds) {
    return { ok: false, code: "too_long", values: { seconds: meta.durationSeconds } };
  }
  const side = Math.max(meta.width, meta.height);
  if (side > limits.video.maxSide) return { ok: false, code: "too_big", values: { side } };
  return { ok: true, kind: "video", mimeType: sniffed.mimeType, checksAfterUpload: false };
}
