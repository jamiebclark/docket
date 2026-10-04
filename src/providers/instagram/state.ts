import { z } from "zod";

export const FIRST_CHECK_DELAY_MS = 10_000;
export const MAX_CHECK_INTERVAL_MS = 300_000;
export const PROCESSING_CAP_MS = 60 * 60_000;
export const CONTAINER_SAFE_AGE_MS = 23 * 3_600_000; // containers expire after 24 h
export const MAX_RECREATIONS = 2;

/** Later kinds (VIDEO, REELS) add values here and a create step in steps.ts/publish.ts. */
export const instagramStateSchema = z.object({
  v: z.literal(1),
  mediaType: z.enum(["IMAGE", "CAROUSEL"]),
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

export function initialState(mediaCount: number): InstagramState {
  return {
    v: 1,
    mediaType: mediaCount >= 2 ? "CAROUSEL" : "IMAGE",
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
