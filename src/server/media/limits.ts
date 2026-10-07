import { MIME_LABEL, UPLOAD_MIME_TYPES, VIDEO_MAX_SIDE, VIDEO_MIME_LABEL, VIDEO_UPLOAD_MIME_TYPES } from "@/lib/media/types";
import type { Env } from "@/server/env";

export interface LibraryLimits {
  image: { types: readonly string[]; typeLabels: string[]; maxBytes: number; maxMegapixels: number };
  video: { types: readonly string[]; typeLabels: string[]; maxBytes: number; maxSeconds: number; maxSide: number };
}

/** The single source of upload limits for the services, the worker and the browser. */
export function libraryLimits(env: Pick<Env, "media">): LibraryLimits {
  const m = env.media;
  return {
    image: {
      types: UPLOAD_MIME_TYPES,
      typeLabels: UPLOAD_MIME_TYPES.map((t) => MIME_LABEL[t] ?? t),
      maxBytes: m.maxUploadBytes,
      maxMegapixels: m.maxPixels / 1_000_000,
    },
    video: {
      types: VIDEO_UPLOAD_MIME_TYPES,
      typeLabels: VIDEO_UPLOAD_MIME_TYPES.map((t) => VIDEO_MIME_LABEL[t] ?? t),
      maxBytes: m.maxVideoBytes,
      maxSeconds: m.maxVideoSeconds,
      maxSide: VIDEO_MAX_SIDE,
    },
  };
}
