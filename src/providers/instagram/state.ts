import { z } from "zod";

export const FIRST_CHECK_DELAY_MS = 10_000;
export const MAX_CHECK_INTERVAL_MS = 300_000;
export const PROCESSING_CAP_MS = 60 * 60_000;
export const CONTAINER_SAFE_AGE_MS = 23 * 3_600_000; // containers expire after 24 h
export const MAX_RECREATIONS = 2;

export const VIDEO_FIRST_CHECK_DELAY_MS = 60_000;
export const VIDEO_SLOW_AFTER_MS = 300_000;

/** Fields beyond the v1 image shape are optional, so a state saved before 019 still parses (P19). */
export const instagramStateSchema = z.object({
  v: z.literal(1),
  mediaType: z.enum(["IMAGE", "CAROUSEL", "REELS"]),
  /** REELS only: true = Feed video, false = Reel. */
  shareToFeed: z.boolean().optional(),
  /** CAROUSEL only: kind of every planned item, in post order. Absent = all images. */
  kinds: z.array(z.enum(["image", "video"])).min(2).max(10).optional(),
  /** Aligned with `items` when `kinds` has a video. */
  itemProgress: z
    .array(z.object({ createdAt: z.string(), checks: z.number().int().min(0), ready: z.boolean() }))
    .max(10)
    .optional(),
  /** Carousel item container ids, in image order ([] for IMAGE). */
  items: z.array(z.string().min(1).max(100)).max(10),
  /** The image or carousel container id. */
  container: z.string().min(1).max(100).nullable(),
  /** ISO time `container` was created (polling cap and 23 h guard). */
  createdAt: z.string().nullable(),
  checks: z.number().int().min(0),
  ready: z.boolean(),
  quotaChecked: z.boolean(),
  recreations: z.number().int().min(0).max(MAX_RECREATIONS),
});
export type InstagramState = z.infer<typeof instagramStateSchema>;

/** What the content publishes as; derived from the post, never stored on its own. */
export interface InstagramPlan {
  mediaType: "IMAGE" | "CAROUSEL" | "REELS";
  shareToFeed?: boolean;
  kinds?: readonly ("image" | "video")[];
}

export function initialState(plan: InstagramPlan | number): InstagramState {
  const p: InstagramPlan = typeof plan === "number" ? { mediaType: plan >= 2 ? "CAROUSEL" : "IMAGE" } : plan;
  return {
    v: 1,
    mediaType: p.mediaType,
    ...(p.mediaType === "REELS" ? { shareToFeed: p.shareToFeed ?? true } : {}),
    ...(p.mediaType === "CAROUSEL" && p.kinds?.includes("video") ? { kinds: [...p.kinds], itemProgress: [] } : {}),
    items: [],
    container: null,
    createdAt: null,
    checks: 0,
    ready: false,
    quotaChecked: false,
    recreations: 0,
  };
}

/** Check interval after `checks` checks have been made: 10 s doubling to 5 min. */
export function checkIntervalMs(checks: number): number {
  return Math.min(FIRST_CHECK_DELAY_MS * 2 ** Math.min(checks, 20), MAX_CHECK_INTERVAL_MS);
}

/** Check interval for a video container or item of this age: 60 s up to 5 minutes, then 5 minutes. */
export function videoCheckDelayMs(ageMs: number): number {
  return ageMs < VIDEO_SLOW_AFTER_MS ? VIDEO_FIRST_CHECK_DELAY_MS : MAX_CHECK_INTERVAL_MS;
}
