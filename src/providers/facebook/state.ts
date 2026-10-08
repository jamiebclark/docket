import { reelStateSchema, type ReelState } from "./settings";

export const CHECK_FIRST_MS = 60_000;
export const CHECK_SLOW_AFTER_MS = 300_000;
export const CHECK_SLOW_MS = 300_000;
export const UPLOAD_CEILING_MS = 30 * 60_000;
export const PUBLISH_CEILING_MS = 60 * 60_000;

/** The wait before the next read of a Reel's status: every minute for five minutes, then every five. */
export function checkDelayMs(ageMs: number): number {
  return ageMs < CHECK_SLOW_AFTER_MS ? CHECK_FIRST_MS : CHECK_SLOW_MS;
}

/** A Reel state that parses and keeps its invariants, else null (an unreadable state is never trusted). */
export function validReelState(state: unknown): ReelState | null {
  const parsed = reelStateSchema.safeParse(state);
  if (!parsed.success) return null;
  const s = parsed.data;
  if (s.uploadComplete && s.uploadedAt === null) return null;
  if (s.finishedAt !== null && !s.uploadComplete) return null;
  if (s.publishChecks > 0 && s.finishedAt === null) return null;
  return s;
}
