// scheduler/housekeeping: bounded deletes of expired rows at the end of a tick (research D16).
import { purgeExpiredIdempotencyKeys } from "../dal/idempotency";
import { crossProject } from "../dal/scope";
import { listExpiredUploads, markUploadExpired } from "../dal/uploads-housekeeping";
import { getEnv } from "../env";
import { getStorage } from "../storage";

export const HOUSEKEEPING_BATCH = 500;

export const EXPIRE_UPLOADS_BATCH = 20;
const ABORT_TIMEOUT_MS = 5000;

export interface HousekeepingCounts {
  idempotencyPurged: number;
  uploadsExpired: number;
}

export function emptyHousekeepingCounts(): HousekeepingCounts {
  return { idempotencyPurged: 0, uploadsExpired: 0 };
}

/**
 * Expires upload sessions nobody finished (P2): aborts the multipart upload, removes the staging object and marks
 * the row `expired`. At most one small batch per tick; it needs no ffmpeg, so it runs wherever the scheduler runs.
 */
export async function expireUploads(now = new Date()): Promise<number> {
  const storage = getStorage();
  if (!storage) return 0;
  const sessions = await crossProject("housekeeping: expire uploads", () =>
    listExpiredUploads(now, getEnv().media.uploadExpiryHours, EXPIRE_UPLOADS_BATCH),
  );
  let expired = 0;
  for (const s of sessions) {
    const moved = await crossProject("housekeeping: expire uploads", () => markUploadExpired(s.id, now));
    if (!moved) continue;
    expired++;
    const guard = <T>(work: Promise<T>) =>
      Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), ABORT_TIMEOUT_MS).unref())]);
    if (s.storageUploadId) await guard(storage.abortMultipart(s.storageKey, s.storageUploadId)).catch(() => undefined);
    await guard(storage.delete(s.storageKey)).catch(() => console.error(`housekeeping: could not delete ${s.storageKey}`));
  }
  return expired;
}

/** Deletes at most one batch per table, so a tick never stalls on a large backlog. */
export async function runHousekeeping(): Promise<HousekeepingCounts> {
  const idempotencyPurged = await crossProject("housekeeping: purge expired idempotency keys", () =>
    purgeExpiredIdempotencyKeys(HOUSEKEEPING_BATCH),
  );
  const uploadsExpired = await expireUploads();
  return { idempotencyPurged, uploadsExpired };
}
