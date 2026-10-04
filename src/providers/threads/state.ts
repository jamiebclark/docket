import { z } from "zod";

const id = z.string().regex(/^\d{1,40}$/);

export const threadsStateSchema = z.object({
  v: z.literal(1),
  mediaType: z.enum(["TEXT", "IMAGE", "CAROUSEL"]),
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

export type ThreadsMediaType = ThreadsState["mediaType"];

/** 0 → TEXT, 1 → IMAGE, 2 and over → CAROUSEL. */
export function mediaTypeFor(count: number): ThreadsMediaType {
  return count === 0 ? "TEXT" : count === 1 ? "IMAGE" : "CAROUSEL";
}

export function initialState(mediaCount: number): ThreadsState {
  return {
    v: 1,
    mediaType: mediaTypeFor(mediaCount),
    items: [],
    container: null,
    createdAt: null,
    checks: 0,
    ready: false,
    quotaChecked: false,
    recreations: 0,
  };
}
