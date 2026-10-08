import { and, eq, sql } from "drizzle-orm";
import { getDb, type Database } from "../db/client";
import { mediaAssets, videoVersions, type MediaAssetRow, type VideoVersionRow } from "../db/schema";

/** Same lease as entry 2's media loop (renewed every 30 s). */
export const VERSION_LEASE_SECONDS = 120;
export const MAX_VERSION_ATTEMPTS = 3;

/** What an output was read back as (D13); every field is required for `ready` (`video_versions_ready_facts`). */
export interface VersionFacts {
  storageKey: string;
  publicUrl: string;
  container: "mp4" | "mov";
  width: number;
  height: number;
  durationMs: number;
  frameRate: number;
  videoCodec: string;
  audioCodec: string | null;
  videoBitrate: number;
  byteSize: number;
}

export interface ClaimedVersion {
  version: VideoVersionRow & { leaseToken: string };
  asset: MediaAssetRow;
}

export interface VideoVersionProcessingRepo {
  /**
   * The most urgent queued version (or `building` one whose lease expired) of a live asset, leased with the attempt counted.
   * Order: `due_at` soonest first, nulls last, then oldest.
   */
  claimNext(now: Date): Promise<ClaimedVersion | null>;
  /** False when the lease was lost, the row was removed or the asset was deleted. */
  renewLease(id: string, token: string, now: Date): Promise<boolean>;
  /** Graceful shutdown: lease cleared, attempt refunded, back to `queued`. */
  release(id: string, token: string): Promise<boolean>;
  /** Conditional on the token and a live asset; false means the caller must delete what it uploaded. */
  finishReady(id: string, token: string, facts: VersionFacts): Promise<boolean>;
  finishFailed(id: string, token: string, reason: string): Promise<boolean>;
  /** A failed attempt with budget left: lease cleared, back to `queued`. */
  retryLater(id: string, token: string): Promise<boolean>;
}

/**
 * The cross-project claim repo of the version worker (data-model §4). Use only inside `crossProject("video: …", …)`.
 * Every write after the claim is conditional on the lease token and a live asset.
 */
export function createVideoVersionProcessingRepo(db: Database): VideoVersionProcessingRepo {
  const liveAsset = sql`EXISTS (SELECT 1 FROM ${mediaAssets} WHERE ${mediaAssets.id} = ${videoVersions.mediaAssetId} AND ${mediaAssets.deletedAt} IS NULL)`;
  const held = (id: string, token: string) =>
    and(eq(videoVersions.id, id), eq(videoVersions.leaseToken, token), eq(videoVersions.state, "building"), liveAsset);
  const leaseUntil = (now: Date) => new Date(now.getTime() + VERSION_LEASE_SECONDS * 1000);
  const idle = { leaseUntil: null, leaseToken: null } as const;
  return {
    async claimNext(now) {
      const next = sql`(
        SELECT vv.id FROM ${videoVersions} vv
        JOIN ${mediaAssets} a ON a.id = vv.media_asset_id AND a.deleted_at IS NULL
        WHERE vv.state = 'queued' OR (vv.state = 'building' AND vv.lease_until < ${now})
        ORDER BY vv.due_at ASC NULLS LAST, vv.created_at
        LIMIT 1
        FOR UPDATE OF vv SKIP LOCKED
      )`;
      const [row] = await db
        .update(videoVersions)
        .set({
          state: "building",
          attempts: sql`${videoVersions.attempts} + 1`,
          leaseUntil: leaseUntil(now),
          leaseToken: sql`gen_random_uuid()`,
        })
        .where(eq(videoVersions.id, next))
        .returning();
      if (!row) return null;
      const [asset] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, row.mediaAssetId)).limit(1);
      // The asset was deleted between the claim and this read: nothing to build, so give the row back to the cascade.
      if (!asset || asset.deletedAt) return null;
      return { version: row as ClaimedVersion["version"], asset };
    },
    async renewLease(id, token, now) {
      const rows = await db.update(videoVersions).set({ leaseUntil: leaseUntil(now) }).where(held(id, token)).returning({ id: videoVersions.id });
      return rows.length > 0;
    },
    async release(id, token) {
      const rows = await db
        .update(videoVersions)
        .set({ ...idle, state: "queued", attempts: sql`GREATEST(${videoVersions.attempts} - 1, 0)` })
        .where(held(id, token))
        .returning({ id: videoVersions.id });
      return rows.length > 0;
    },
    async finishReady(id, token, f) {
      const rows = await db
        .update(videoVersions)
        .set({ ...idle, state: "ready", error: null, finishedAt: sql`now()`, ...f })
        .where(held(id, token))
        .returning({ id: videoVersions.id });
      return rows.length > 0;
    },
    async finishFailed(id, token, reason) {
      const rows = await db
        .update(videoVersions)
        .set({ ...idle, state: "failed", error: reason.slice(0, 300), finishedAt: sql`now()` })
        .where(held(id, token))
        .returning({ id: videoVersions.id });
      return rows.length > 0;
    },
    async retryLater(id, token) {
      const rows = await db
        .update(videoVersions)
        .set({ ...idle, state: "queued" })
        .where(held(id, token))
        .returning({ id: videoVersions.id });
      return rows.length > 0;
    },
  };
}

/** The repo on the shared pool; call inside `crossProject(…)`. */
export const videoVersionProcessingRepo = (): VideoVersionProcessingRepo => createVideoVersionProcessingRepo(getDb());
