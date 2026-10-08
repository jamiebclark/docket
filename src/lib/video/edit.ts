import { z } from "zod";

export type VideoFit = "pad_blur" | "pad_color" | "crop";

/** One edit per video per post; every target of the post uses it (client-safe). */
export interface VideoEdit {
  /** Multiple of 100. */
  trimStartMs: number;
  /** Multiple of 100; null = end of video. */
  trimEndMs: number | null;
  fit: VideoFit;
  /** "#rrggbb", lower case. */
  padColor: string;
  /** 0..1 of the displayed width. */
  focalX: number;
  /** 0..1 of the displayed height. */
  focalY: number;
  recommendedShape: boolean;
}

export const DEFAULT_VIDEO_EDIT: VideoEdit = {
  trimStartMs: 0,
  trimEndMs: null,
  fit: "pad_blur",
  padColor: "#000000",
  focalX: 0.5,
  focalY: 0.5,
  recommendedShape: false,
};

/** The shortest part a trim may keep. */
export const MIN_TRIM_MS = 1000;

const tenth = (what: string) => z.number().int().refine((n) => n % 100 === 0, `${what} must be a multiple of 0.1 seconds.`);

export const videoEditSchema = z
  .object({
    trimStartMs: tenth("The start").min(0),
    trimEndMs: tenth("The end").min(0).nullable(),
    fit: z.enum(["pad_blur", "pad_color", "crop"]),
    padColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, "Use a colour like #1a2b3c.")
      .transform((s) => s.toLowerCase()),
    focalX: z.number().min(0).max(1),
    focalY: z.number().min(0).max(1),
    recommendedShape: z.boolean(),
  })
  .superRefine((e, ctx) => {
    if (e.trimEndMs !== null && e.trimEndMs < e.trimStartMs + MIN_TRIM_MS) {
      ctx.addIssue({ code: "custom", path: ["trimEndMs"], message: "The end must be at least 1 second after the start." });
    }
  });

export const isDefaultEdit = (e: VideoEdit): boolean =>
  e.trimStartMs === DEFAULT_VIDEO_EDIT.trimStartMs &&
  e.trimEndMs === DEFAULT_VIDEO_EDIT.trimEndMs &&
  e.fit === DEFAULT_VIDEO_EDIT.fit &&
  e.padColor === DEFAULT_VIDEO_EDIT.padColor &&
  e.focalX === DEFAULT_VIDEO_EDIT.focalX &&
  e.focalY === DEFAULT_VIDEO_EDIT.focalY &&
  e.recommendedShape === DEFAULT_VIDEO_EDIT.recommendedShape;

export class VideoEditError extends Error {
  constructor(
    readonly field: "trimStartMs" | "trimEndMs",
    message: string,
  ) {
    super(message);
    this.name = "VideoEditError";
  }
}

/**
 * Checks an edit against the video's length: the end may not pass it, and the kept part is at least one second.
 * Returns the edit with an end equal to the duration normalised to `null`. Throws `VideoEditError` otherwise.
 */
export function assertEditFits(edit: VideoEdit, durationMs: number): VideoEdit {
  if (edit.trimStartMs > durationMs - MIN_TRIM_MS) {
    throw new VideoEditError("trimStartMs", "The start must leave at least 1 second of the video.");
  }
  if (edit.trimEndMs !== null && edit.trimEndMs > durationMs) {
    throw new VideoEditError("trimEndMs", "The end is after the end of the video.");
  }
  const end = edit.trimEndMs ?? durationMs;
  if (end - edit.trimStartMs < MIN_TRIM_MS) {
    throw new VideoEditError("trimEndMs", "The kept part must be at least 1 second.");
  }
  return edit.trimEndMs === durationMs ? { ...edit, trimEndMs: null } : edit;
}
