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
  thumbnailStorageKey: string;
  thumbnailUrl: string;
}

export interface MediaProcessingRepo {
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
