import { and, asc, eq, inArray, lt, or } from "drizzle-orm";
import { getDb } from "../db/client";
import { mediaUploads } from "../db/schema";

/** A `completing` session older than this is a crashed completion. */
export const COMPLETING_STALE_MS = 60 * 60 * 1000;

export interface ExpiredUpload {
  id: string;
  projectId: string;
  storageKey: string;
  storageUploadId: string | null;
}

/**
 * Cross-project housekeeping: `open` sessions older than `hours`, and `completing` sessions older than an hour.
 * Call only inside `crossProject("housekeeping: expire uploads", …)`.
 */
export async function listExpiredUploads(now: Date, hours: number, limit: number): Promise<ExpiredUpload[]> {
  const openCutoff = new Date(now.getTime() - hours * 3_600_000);
  const completingCutoff = new Date(now.getTime() - COMPLETING_STALE_MS);
  return getDb()
    .select({
      id: mediaUploads.id,
      projectId: mediaUploads.projectId,
      storageKey: mediaUploads.storageKey,
      storageUploadId: mediaUploads.storageUploadId,
    })
    .from(mediaUploads)
    .where(
      or(
        and(eq(mediaUploads.state, "open"), lt(mediaUploads.createdAt, openCutoff)),
        and(eq(mediaUploads.state, "completing"), lt(mediaUploads.createdAt, completingCutoff)),
      ),
    )
    .orderBy(asc(mediaUploads.createdAt))
    .limit(limit);
}

/** Moves one session to `expired`; false when something else finished it first. */
export async function markUploadExpired(id: string, now = new Date()): Promise<boolean> {
  const rows = await getDb()
    .update(mediaUploads)
    .set({ state: "expired", finishedAt: now })
    .where(and(eq(mediaUploads.id, id), inArray(mediaUploads.state, ["open", "completing"])))
    .returning({ id: mediaUploads.id });
  return rows.length > 0;
}
