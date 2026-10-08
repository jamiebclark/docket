import { z } from "zod";

/** Every constant of data-model §4. All times come from the engine clock; no step sleeps. */
export const SERVICE_TOKEN_TTL_SECONDS = 300;
export const LIMIT_RETRY_MS = 3_600_000;
export const LIMIT_GIVE_UP_MS = 82_800_000;
export const EXPIRY_MARGIN_MS = 60_000;
export const MAX_RESTARTS = 2;
export const FIRST_READ_DELAY_MS = 30_000;
export const FAST_READ_INTERVAL_MS = 60_000;
export const FAST_PHASE_MS = 600_000;
export const SLOW_READ_INTERVAL_MS = 300_000;
export const PROCESSING_CEILING_MS = 1_800_000;
export const MAX_JOB_READS = 16;
export const MAX_VIDEO_BYTES = 300_000_000;

export const videoBlobSchema = z.object({
  $type: z.literal("blob"),
  ref: z.object({ $link: z.string().min(1) }),
  mimeType: z.literal("video/mp4"),
  size: z.number().int().min(1),
});
export type VideoBlob = z.infer<typeof videoBlobSchema>;

export const VIDEO_PHASES = ["limits", "start", "parts", "finish", "job", "ready"] as const;
export type VideoPhase = (typeof VIDEO_PHASES)[number];

const iso = z.string().datetime();

const videoUploadShape = z.object({
  phase: z.enum(VIDEO_PHASES),
  restarts: z.number().int().min(0).max(MAX_RESTARTS).default(0),
  limitWaitSince: iso.optional(),
  limitsCheck: z.enum(["ok", "skipped"]).optional(),
  pdsHost: z.string().regex(/^[a-z0-9.-]{1,253}$/).optional(),
  pdsHostSource: z.enum(["session", "configured"]).optional(),
  url: z.string().min(1).optional(),
  sizeBytes: z.number().int().min(1).max(MAX_VIDEO_BYTES).optional(),
  jobId: z.string().min(1).max(200).optional(),
  partSizeBytes: z.number().int().min(1).optional(),
  partCount: z.number().int().min(1).max(10_000).optional(),
  partsSent: z.number().int().min(0).optional(),
  expiresAt: iso.optional(),
  pollJobId: z.string().min(1).max(200).optional(),
  finishedAt: iso.optional(),
  reads: z.number().int().min(0).max(MAX_JOB_READS).optional(),
  lastReadAt: iso.optional(),
  statusAuth: z.enum(["service", "none"]).default("service"),
  blob: videoBlobSchema.optional(),
});

/** The per-phase invariants of data-model §2: a state that breaks them is unreadable. */
function consistent(v: z.infer<typeof videoUploadShape>): boolean {
  const upload = v.url !== undefined && v.sizeBytes !== undefined && v.jobId !== undefined && v.partSizeBytes !== undefined && v.partCount !== undefined && v.expiresAt !== undefined;
  switch (v.phase) {
    case "limits":
      return true;
    case "start":
      return v.pdsHost !== undefined;
    case "parts":
    case "finish": {
      if (!upload || v.pdsHost === undefined) return false;
      const sent = v.partsSent ?? 0;
      const count = v.partCount!;
      const part = v.partSizeBytes!;
      const size = v.sizeBytes!;
      if (!((count - 1) * part < size && size <= count * part)) return false;
      return v.phase === "parts" ? sent >= 0 && sent < count : sent === count;
    }
    case "job":
      return v.pollJobId !== undefined && v.finishedAt !== undefined;
    case "ready":
      return v.blob !== undefined;
  }
}

export const videoUploadSchema = videoUploadShape.refine(consistent, { message: "inconsistent video upload state" });
export type VideoUpload = z.infer<typeof videoUploadSchema>;

/**
 * Drops a saved state that does not fit the post's media (P18): a video upload under images, or image blobs under
 * a video. `video` is whether the post is exactly one video.
 */
export function fitState<S extends { v: 1; blobs: readonly unknown[]; video?: unknown }>(state: S, content: { isVideo: boolean }): S {
  if (content.isVideo && state.blobs.length > 0) return { v: 1, blobs: [] } as unknown as S;
  if (!content.isVideo && state.video !== undefined) return { v: 1, blobs: [] } as unknown as S;
  return state;
}

/** Part `k` (from 1): inclusive byte range of the file (P7). */
export function partRange(k: number, partSizeBytes: number, sizeBytes: number): { first: number; last: number } {
  const first = (k - 1) * partSizeBytes;
  return { first, last: Math.min(k * partSizeBytes, sizeBytes) - 1 };
}

/** When the next status read is due after a read without a blob (P12). */
export function nextReadAt(readAt: Date, finishedAt: Date): Date {
  const interval = readAt.getTime() < finishedAt.getTime() + FAST_PHASE_MS ? FAST_READ_INTERVAL_MS : SLOW_READ_INTERVAL_MS;
  return new Date(readAt.getTime() + interval);
}
