// scheduler/housekeeping: bounded deletes of expired rows at the end of a tick (research D16).
import { now } from "../dal/clock";
import { pruneOrphanCreditHolds } from "../dal/credit-holds";
import { purgeExpiredIdempotencyKeys } from "../dal/idempotency";
import { pruneAllowanceUsesBefore } from "../dal/scheduler";
import { crossProject } from "../dal/scope";
import { pruneClosedStandingSeriesRunsBefore } from "../dal/standing-series";
import { pruneSettledOccurrencesBefore } from "../dal/standing-series-dated";
import { listExpiredUploads, markUploadExpired } from "../dal/uploads-housekeeping";
import { listCollectableVideoVersions, reposForProject } from "../dal/video-housekeeping";
import { getEnv } from "../env";
import { pruneEngagementItems } from "../services/engagement/retention";
import { foldAndPruneAccountSnapshots, foldAndPrunePostSnapshots } from "../services/insights/retention";
import { wantedVideoKeys } from "../services/video-versions";
import { getStorage } from "../storage";
import { shapeFor } from "../../providers/registry";
import type { SchedulerConfig } from "./config";

export const HOUSEKEEPING_BATCH = 500;
export const ALLOWANCE_PRUNE_BATCH = 1000;
const ALLOWANCE_RETENTION_MS = 7 * 86_400_000;

export const EXPIRE_UPLOADS_BATCH = 20;
const ABORT_TIMEOUT_MS = 5000;

export const COLLECT_VIDEO_BATCH = 20;
/** A version or preview nobody has asked for in this long is checked against what the posts plan today. */
const VIDEO_VERSION_GRACE_MS = 24 * 3_600_000;

export const ORPHAN_HOLD_BATCH = 100;

export const STANDING_SERIES_RUN_RETENTION_DAYS = 90;
export const STANDING_SERIES_RUN_PRUNE_BATCH = 200;

export interface HousekeepingCounts {
  idempotencyPurged: number;
  uploadsExpired: number;
  allowanceUsesPruned: number;
  videoVersionsRemoved: number;
  orphanHoldsPruned: number;
  standingSeriesRunsPruned: number;
  standingSeriesOccurrencesPruned: number;
  engagementItemsPruned: number;
  postMetricSnapshotsPruned: number;
  accountMetricSnapshotsPruned: number;
  /** data-model.md §8 (US5, FR-055). Rollup points written or advanced by the fold, this pass. */
  accountMetricPointsFolded: number;
  postMetricPointsFolded: number;
}

export function emptyHousekeepingCounts(): HousekeepingCounts {
  return {
    idempotencyPurged: 0,
    uploadsExpired: 0,
    allowanceUsesPruned: 0,
    videoVersionsRemoved: 0,
    orphanHoldsPruned: 0,
    standingSeriesRunsPruned: 0,
    standingSeriesOccurrencesPruned: 0,
    engagementItemsPruned: 0,
    postMetricSnapshotsPruned: 0,
    accountMetricSnapshotsPruned: 0,
    accountMetricPointsFolded: 0,
    postMetricPointsFolded: 0,
  };
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

/**
 * Removes video versions and previews no post plans any more, at most one small batch per tick (P17, FR-033). A row still
 * wanted is marked checked; otherwise its row goes, then its object. `building` rows are never touched. Needs no ffmpeg.
 */
export async function collectVideoVersions(now = new Date()): Promise<number> {
  const rows = await crossProject("housekeeping: collect video versions", () =>
    listCollectableVideoVersions(new Date(now.getTime() - VIDEO_VERSION_GRACE_MS), COLLECT_VIDEO_BATCH),
  );
  const storage = getStorage();
  const wantedByAsset = new Map<string, Set<string>>();
  let removed = 0;
  for (const row of rows) {
    const repos = reposForProject(row.projectId);
    let wanted = wantedByAsset.get(row.mediaAssetId);
    if (!wanted) {
      wanted = await crossProject("housekeeping: collect video versions", () =>
        wantedVideoKeys({ ...repos, project: { id: row.projectId } }, row.mediaAssetId),
      );
      wantedByAsset.set(row.mediaAssetId, wanted);
    }
    if (wanted.has(`${row.kind}:${row.key}`)) {
      await crossProject("housekeeping: collect video versions", () => repos.videoVersions.markChecked([row.id], now));
      continue;
    }
    await crossProject("housekeeping: collect video versions", () => repos.videoVersions.delete(row.id));
    removed++;
    if (row.storageKey && storage) {
      const key = row.storageKey;
      await Promise.race([
        storage.delete(key),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), ABORT_TIMEOUT_MS).unref()),
      ]).catch(() => console.error(`housekeeping: could not delete ${key}`));
    }
  }
  return removed;
}

/** Deletes allowance reservations older than 7 days, in batches (the rolling window is at most that long). */
export async function pruneAllowanceUses(now = new Date()): Promise<number> {
  const before = new Date(now.getTime() - ALLOWANCE_RETENTION_MS);
  let total = 0;
  for (;;) {
    const gone = await crossProject("housekeeping: prune allowance uses", () => pruneAllowanceUsesBefore(before, ALLOWANCE_PRUNE_BATCH));
    total += gone;
    if (gone < ALLOWANCE_PRUNE_BATCH) return total;
  }
}

/** Deletes credit-hold rows for a project credential whose project is gone (AS7), one bounded batch per tick. */
export async function pruneOrphanHolds(): Promise<number> {
  return crossProject("housekeeping: prune orphan credit holds", () => pruneOrphanCreditHolds(ORPHAN_HOLD_BATCH));
}

/** Deletes closed standing-series runs past retention (**S39**), one bounded batch per tick; an open run is never matched. */
export async function pruneClosedStandingSeriesRuns(at = new Date()): Promise<number> {
  const before = new Date(at.getTime() - STANDING_SERIES_RUN_RETENTION_DAYS * 86_400_000);
  return crossProject("housekeeping: prune closed standing series runs", () =>
    pruneClosedStandingSeriesRunsBefore(before, STANDING_SERIES_RUN_PRUNE_BATCH),
  );
}

/** Deletes closed standing-series occurrences past retention (contracts/worker.md §6), one bounded batch per tick; a pending occurrence is never matched. */
export async function pruneSettledOccurrences(at = new Date()): Promise<number> {
  const before = new Date(at.getTime() - STANDING_SERIES_RUN_RETENTION_DAYS * 86_400_000);
  return crossProject("housekeeping: prune settled standing series occurrences", () =>
    pruneSettledOccurrencesBefore(before, STANDING_SERIES_RUN_PRUNE_BATCH),
  );
}

/** Deletes at most one batch per table, so a tick never stalls on a large backlog. */
export async function runHousekeeping(config: SchedulerConfig): Promise<HousekeepingCounts> {
  const idempotencyPurged = await crossProject("housekeeping: purge expired idempotency keys", () =>
    purgeExpiredIdempotencyKeys(HOUSEKEEPING_BATCH),
  );
  const uploadsExpired = await expireUploads();
  const allowanceUsesPruned = await pruneAllowanceUses(await now());
  const videoVersionsRemoved = await collectVideoVersions(await now());
  const orphanHoldsPruned = await pruneOrphanHolds();
  const standingSeriesRunsPruned = await pruneClosedStandingSeriesRuns(await now());
  const standingSeriesOccurrencesPruned = await pruneSettledOccurrences(await now());
  const engagementItemsPruned = await pruneEngagementItems(config, await now());
  const accountFold = await foldAndPruneAccountSnapshots(config, await now(), shapeFor);
  const postFold = await foldAndPrunePostSnapshots(config, await now(), shapeFor);
  return {
    idempotencyPurged,
    uploadsExpired,
    allowanceUsesPruned,
    videoVersionsRemoved,
    orphanHoldsPruned,
    standingSeriesRunsPruned,
    standingSeriesOccurrencesPruned,
    engagementItemsPruned,
    postMetricSnapshotsPruned: postFold.snapshotsDeleted,
    accountMetricSnapshotsPruned: accountFold.snapshotsDeleted,
    accountMetricPointsFolded: accountFold.pointsFolded,
    postMetricPointsFolded: postFold.pointsFolded,
  };
}
