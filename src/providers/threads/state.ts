import { z } from "zod";

const id = z.string().regex(/^\d{1,40}$/);

const kind = z.enum(["image", "video"]);
const progress = z.object({ createdAt: z.iso.datetime(), checks: z.number().int().min(0), ready: z.boolean() });

export const threadsStateSchema = z.object({
  v: z.literal(1),
  mediaType: z.enum(["TEXT", "IMAGE", "VIDEO", "CAROUSEL"]),
  /** CAROUSEL with at least one video only: every item's kind, in post order. Absent = all images. */
  kinds: z.array(kind).min(2).max(20).optional(),
  /** Aligned with `items` when `kinds` is set. Images are saved ready. */
  itemProgress: z.array(progress).max(20).optional(),
  items: z.array(id).max(20),
  container: id.nullable(),
  createdAt: z.iso.datetime().nullable(),
  checks: z.number().int().min(0),
  ready: z.boolean(),
  quotaChecked: z.boolean(),
  recreations: z.number().int().min(0).max(2),
});
export type ThreadsState = z.infer<typeof threadsStateSchema>;

export const FIRST_CHECK_DELAY_MS = 30_000;
export const CHECK_INTERVAL_MS = 60_000;
export const PROCESSING_CAP_MS = 5 * 60_000;
export const CONTAINER_SAFE_AGE_MS = 23 * 3_600_000; // containers expire after 24 h
export const MAX_RECREATIONS = 2;

// A video container or carousel item is read 30 s after creation, every 60 s while younger than 5 minutes, then
// every 5 minutes, and fails still processing at 60 minutes (research P8, P10).
export const VIDEO_FIRST_CHECK_DELAY_MS = 30_000;
export const VIDEO_SLOW_AFTER_MS = 300_000;
export const VIDEO_SLOW_INTERVAL_MS = 300_000;
export const VIDEO_PROCESSING_CAP_MS = 3_600_000;

/** Delay to the next read of a video container after `IN_PROGRESS`, from the container's age. */
export const videoCheckDelayMs = (ageMs: number) => (ageMs < VIDEO_SLOW_AFTER_MS ? CHECK_INTERVAL_MS : VIDEO_SLOW_INTERVAL_MS);

export type ThreadsMediaType = ThreadsState["mediaType"];

/** 0 → TEXT, 1 → IMAGE, 2 and over → CAROUSEL. */
export function mediaTypeFor(count: number): ThreadsMediaType {
  return count === 0 ? "TEXT" : count === 1 ? "IMAGE" : "CAROUSEL";
}

/** What the content needs, derived on every call and never stored on its own. */
export interface ThreadsPlan {
  mediaType: ThreadsMediaType;
  count: number;
  /** CAROUSEL with at least one video only: kind of every item, in post order. */
  kinds?: readonly ("image" | "video")[];
}

/** 0 → TEXT; 1 → IMAGE or VIDEO by kind; 2–20 → CAROUSEL; otherwise null. `kinds` is used only when it matches the count. */
export function planOf(mediaCount: number, kinds?: readonly ("image" | "video")[]): ThreadsPlan | null {
  if (typeof mediaCount !== "number" || !Number.isFinite(mediaCount)) return null;
  const count = Math.max(0, Math.floor(mediaCount));
  if (count > 20) return null;
  const known = Array.isArray(kinds) && kinds.length === count ? kinds : undefined;
  if (count === 1) return { mediaType: known?.[0] === "video" ? "VIDEO" : "IMAGE", count };
  if (count < 2) return { mediaType: mediaTypeFor(count), count };
  return known?.includes("video") ? { mediaType: "CAROUSEL", count, kinds: known } : { mediaType: "CAROUSEL", count };
}

export function initialState(input: number | ThreadsPlan): ThreadsState {
  const plan = typeof input === "number" ? { mediaType: mediaTypeFor(input), count: input } : input;
  return {
    v: 1,
    mediaType: plan.mediaType,
    ...(plan.kinds ? { kinds: [...plan.kinds], itemProgress: [] } : {}),
    items: [],
    container: null,
    createdAt: null,
    checks: 0,
    ready: false,
    quotaChecked: false,
    recreations: 0,
  };
}
