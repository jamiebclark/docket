import type { VideoMeta } from "@/lib/upload/precheck";

const READ_TIMEOUT_MS = 10_000; // limit-literal-ok: not a platform limit

/**
 * Reads a video's metadata with an off-DOM `<video preload="metadata">` (research §5). Resolves to null when the
 * browser cannot read it, so the file is uploaded and checked there (FR-005).
 */
export function readVideo(file: Blob): Promise<VideoMeta | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    const timer = setTimeout(() => done(null), READ_TIMEOUT_MS);
    const done = (meta: VideoMeta | null) => {
      clearTimeout(timer);
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
      resolve(meta);
    };
    video.preload = "metadata";
    video.muted = true;
    video.onloadedmetadata = () => {
      const seconds = video.duration;
      if (!Number.isFinite(seconds) || seconds <= 0) return done(null);
      done({ durationSeconds: seconds, width: video.videoWidth, height: video.videoHeight });
    };
    video.onerror = () => done(null);
    video.src = url;
  });
}

/** The first bytes of a file, enough for `sniffMedia`. */
export async function readHead(file: Blob): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(0, 64).arrayBuffer());
}
