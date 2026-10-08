import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb, type Database } from "../db/client";
import { mediaAssets, type MediaAssetRow } from "../db/schema";

export const LEASE_SECONDS = 120;

export interface ReadyFacts {
  mimeType: string;
  container: "mp4" | "mov";
  width: number;
  height: number;
  byteSize: number;
  durationMs: number;
  frameRate: number | null;
  videoCodec: string;
  audioCodec: string | null;
  videoBitrate: number | null;
  audioBitrate: number | null;
  audioSampleRate: number | null;
  audioChannels: number | null;
  indexAtFront: boolean | null;
  thumbnailStorageKey: string;
  thumbnailUrl: string;
}

/** The facts a rescan records; the stored file is never rewritten. */
export interface RescanFacts {
  videoBitrate: number | null;
  audioBitrate: number | null;
  audioSampleRate: number | null;
  audioChannels: number | null;
  indexAtFront: boolean | null;
}

/** Failed rescans after which the planner stops waiting and refuses (P9). */
export const MAX_RESCAN_ATTEMPTS = 3;

export interface MediaProcessingRepo {
  /**
   * One ready, live video whose facts predate the formatter (`facts_version = 1`, fewer than 3 attempts), leased for 120 s
   * with the attempt counted. Videos already used by a post go first. It reuses the processing lease columns, idle on a ready row.
   */
  claimRescan(now: Date): Promise<(MediaAssetRow & { processingLeaseToken: string }) | null>;
  /** Records the facts, sets `facts_version = 2` and clears the lease. False when the lease was lost. */
  finishRescan(id: string, token: string, facts: RescanFacts): Promise<boolean>;
  /** A failed rescan only gives the lease back; the attempt is already counted. */
  releaseRescan(id: string, token: string): Promise<boolean>;
  /** One queued video (or one whose lease expired), leased for 120 s with the attempt counted. Null when none. */
  claimNext(now: Date): Promise<(MediaAssetRow & { processingLeaseToken: string }) | null>;
  /** False when the lease was lost or the row was deleted. */
  renewLease(id: string, token: string, now: Date): Promise<boolean>;
  setStep(id: string, token: string, step: "probing" | "poster"): Promise<boolean>;
  /** Graceful shutdown: lease cleared, attempt refunded, back to `queued`. */
  release(id: string, token: string): Promise<boolean>;
  finishReady(id: string, token: string, facts: ReadyFacts): Promise<boolean>;
  finishFailed(id: string, token: string, reason: string): Promise<boolean>;
}

/**
 * The cross-project claim repo of the media worker (data-model §1). Use only inside
 * `crossProject("media: …", …)`. Every write after the claim is conditional on the lease token and a live row.
 */
export function createMediaProcessingRepo(db: Database): MediaProcessingRepo {
  const held = (id: string, token: string) =>
    and(eq(mediaAssets.id, id), eq(mediaAssets.processingLeaseToken, token), isNull(mediaAssets.deletedAt));
  const leaseUntil = (now: Date) => new Date(now.getTime() + LEASE_SECONDS * 1000);
  return {
    async claimNext(now) {
      const next = sql`(
        SELECT ${mediaAssets.id} FROM ${mediaAssets}
        WHERE ${mediaAssets.kind} = 'video' AND ${mediaAssets.processingState} = 'processing'
          AND ${mediaAssets.deletedAt} IS NULL
          AND (${mediaAssets.processingLeaseUntil} IS NULL OR ${mediaAssets.processingLeaseUntil} < ${now})
        ORDER BY ${mediaAssets.createdAt}
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )`;
      const [row] = await db
        .update(mediaAssets)
        .set({
          processingAttempts: sql`${mediaAssets.processingAttempts} + 1`,
          processingLeaseUntil: leaseUntil(now),
          processingLeaseToken: sql`gen_random_uuid()`,
          processingStep: sql`CASE WHEN ${mediaAssets.processingStep} = 'queued' THEN 'probing' ELSE ${mediaAssets.processingStep} END`,
        })
        .where(eq(mediaAssets.id, next))
        .returning();
      return (row as (MediaAssetRow & { processingLeaseToken: string }) | undefined) ?? null;
    },
    async claimRescan(now) {
      const next = sql`(
        SELECT ${mediaAssets.id} FROM ${mediaAssets}
        WHERE ${mediaAssets.kind} = 'video' AND ${mediaAssets.processingState} = 'ready'
          AND ${mediaAssets.deletedAt} IS NULL
          AND ${mediaAssets.factsVersion} < 2 AND ${mediaAssets.factsAttempts} < ${MAX_RESCAN_ATTEMPTS}
          AND (${mediaAssets.processingLeaseUntil} IS NULL OR ${mediaAssets.processingLeaseUntil} < ${now})
        ORDER BY (${mediaAssets.firstUsedAt} IS NULL), ${mediaAssets.createdAt}
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )`;
      const [row] = await db
        .update(mediaAssets)
        .set({
          factsAttempts: sql`${mediaAssets.factsAttempts} + 1`,
          processingLeaseUntil: leaseUntil(now),
          processingLeaseToken: sql`gen_random_uuid()`,
        })
        .where(eq(mediaAssets.id, next))
        .returning();
      return (row as (MediaAssetRow & { processingLeaseToken: string }) | undefined) ?? null;
    },
    async finishRescan(id, token, f) {
      const rows = await db
        .update(mediaAssets)
        .set({
          videoBitrate: f.videoBitrate,
          audioBitrate: f.audioBitrate,
          audioSampleRate: f.audioSampleRate,
          audioChannels: f.audioChannels,
          indexAtFront: f.indexAtFront,
          factsVersion: 2,
          processingLeaseUntil: null,
          processingLeaseToken: null,
        })
        .where(held(id, token))
        .returning({ id: mediaAssets.id });
      return rows.length > 0;
    },
    async releaseRescan(id, token) {
      const rows = await db
        .update(mediaAssets)
        .set({ processingLeaseUntil: null, processingLeaseToken: null })
        .where(held(id, token))
        .returning({ id: mediaAssets.id });
      return rows.length > 0;
    },
    async renewLease(id, token, now) {
      const rows = await db
        .update(mediaAssets)
        .set({ processingLeaseUntil: leaseUntil(now) })
        .where(held(id, token))
        .returning({ id: mediaAssets.id });
      return rows.length > 0;
    },
    async setStep(id, token, step) {
      const rows = await db
        .update(mediaAssets)
        .set({ processingStep: step })
        .where(held(id, token))
        .returning({ id: mediaAssets.id });
      return rows.length > 0;
    },
    async release(id, token) {
      const rows = await db
        .update(mediaAssets)
        .set({
          processingLeaseUntil: null,
          processingLeaseToken: null,
          processingStep: "queued",
          processingAttempts: sql`GREATEST(${mediaAssets.processingAttempts} - 1, 0)`,
        })
        .where(held(id, token))
        .returning({ id: mediaAssets.id });
      return rows.length > 0;
    },
    async finishReady(id, token, f) {
      const rows = await db
        .update(mediaAssets)
        .set({
          processingState: "ready",
          processingStep: null,
          processingError: null,
          processingLeaseUntil: null,
          processingLeaseToken: null,
          sourceStorageKey: null,
          mimeType: f.mimeType,
          container: f.container,
          width: f.width,
          height: f.height,
          byteSize: f.byteSize,
          durationMs: f.durationMs,
          frameRate: f.frameRate,
          videoCodec: f.videoCodec,
          audioCodec: f.audioCodec,
          videoBitrate: f.videoBitrate,
          audioBitrate: f.audioBitrate,
          audioSampleRate: f.audioSampleRate,
          audioChannels: f.audioChannels,
          indexAtFront: f.indexAtFront,
          factsVersion: 2,
          thumbnailStorageKey: f.thumbnailStorageKey,
          thumbnailUrl: f.thumbnailUrl,
        })
        .where(held(id, token))
        .returning({ id: mediaAssets.id });
      return rows.length > 0;
    },
    async finishFailed(id, token, reason) {
      const rows = await db
        .update(mediaAssets)
        .set({
          processingState: "failed",
          processingStep: null,
          processingError: reason.slice(0, 300),
          processingLeaseUntil: null,
          processingLeaseToken: null,
          sourceStorageKey: null,
        })
        .where(held(id, token))
        .returning({ id: mediaAssets.id });
      return rows.length > 0;
    },
  };
}

/** The repo on the shared pool; call inside `crossProject(…)`. */
export const mediaProcessingRepo = (): MediaProcessingRepo => createMediaProcessingRepo(getDb());
