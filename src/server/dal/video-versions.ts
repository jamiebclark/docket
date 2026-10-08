import { and, eq, inArray, lt, sql } from "drizzle-orm";
import type { VideoRecipe, VideoStep } from "../../providers/video-plan";
import type { Database } from "../db/client";
import { videoVersions, type VideoVersionRow } from "../db/schema";

export type VideoVersionKind = "full" | "preview";

export interface VersionRequest {
  assetId: string;
  kind: VideoVersionKind;
  key: string;
  recipe: VideoRecipe;
  steps: readonly VideoStep[];
  /** The earliest time a target wants it; a preview's request time. Null = nobody is waiting. */
  dueAt: Date | null;
}

export interface VideoVersionsRepo {
  getByKeys(pairs: readonly { assetId: string; kind: VideoVersionKind; key: string }[]): Promise<VideoVersionRow[]>;
  /** The preview rows with these keys, in any asset of the project. */
  getPreviewsByKeys(keys: readonly string[]): Promise<VideoVersionRow[]>;
  /**
   * Inserts the rows that are missing as `queued`, and refreshes `requested_at` and the earliest `due_at` of those that exist.
   * With `requeueFailed`, a `failed` row goes back to `queued` with its attempts reset.
   */
  ensureQueued(rows: readonly VersionRequest[], opts?: { requeueFailed?: boolean }): Promise<VideoVersionRow[]>;
  /** Back to `queued` with a fresh budget: a failed version asked for again, or a ready one whose object vanished. */
  requeue(id: string): Promise<boolean>;
  /** Deletes every row of the asset and returns the storage keys that were set, for the caller to remove. */
  deleteForAsset(assetId: string): Promise<string[]>;
  /** Rows nobody has wanted since `before`, never a `building` one. */
  listCollectable(before: Date, limit: number): Promise<VideoVersionRow[]>;
  markChecked(ids: readonly string[], at: Date): Promise<void>;
  delete(id: string): Promise<void>;
}

/** The project-scoped repo of adapted videos and previews (data-model §4). Every statement filters by project. */
export function createVideoVersionsRepo(db: Database, projectId: string): VideoVersionsRepo {
  const inProject = eq(videoVersions.projectId, projectId);
  const lastWanted = sql`GREATEST(${videoVersions.checkedAt}, ${videoVersions.requestedAt})`;
  return {
    async getByKeys(pairs) {
      if (pairs.length === 0) return [];
      const rows = await db
        .select()
        .from(videoVersions)
        .where(and(inProject, inArray(videoVersions.mediaAssetId, [...new Set(pairs.map((p) => p.assetId))]), inArray(videoVersions.key, [...new Set(pairs.map((p) => p.key))])));
      const wanted = new Set(pairs.map((p) => `${p.assetId}:${p.kind}:${p.key}`));
      return rows.filter((r) => wanted.has(`${r.mediaAssetId}:${r.kind}:${r.key}`));
    },
    async getPreviewsByKeys(keys) {
      if (keys.length === 0) return [];
      return db
        .select()
        .from(videoVersions)
        .where(and(inProject, eq(videoVersions.kind, "preview"), inArray(videoVersions.key, [...keys])));
    },
    async ensureQueued(rows, opts = {}) {
      if (rows.length === 0) return [];
      const requeue = opts.requeueFailed === true;
      const reset = <T>(fresh: T, current: unknown) =>
        sql`CASE WHEN ${videoVersions.state} = 'failed' AND ${requeue} THEN ${fresh} ELSE ${current} END`;
      return db
        .insert(videoVersions)
        .values(
          rows.map((r) => ({
            projectId,
            mediaAssetId: r.assetId,
            kind: r.kind,
            key: r.key,
            recipe: r.recipe,
            steps: [...r.steps],
            dueAt: r.dueAt,
          })),
        )
        .onConflictDoUpdate({
          target: [videoVersions.mediaAssetId, videoVersions.kind, videoVersions.key],
          // `where` keeps a row of another project out of reach, though the key space makes a clash impossible.
          setWhere: eq(videoVersions.projectId, projectId),
          set: {
            requestedAt: sql`now()`,
            dueAt: sql`LEAST(${videoVersions.dueAt}, excluded.due_at)`,
            state: reset(sql`'queued'`, videoVersions.state),
            attempts: reset(sql`0`, videoVersions.attempts),
            error: reset(sql`NULL`, videoVersions.error),
          },
        })
        .returning();
    },
    async requeue(id) {
      const rows = await db
        .update(videoVersions)
        .set({
          state: "queued",
          attempts: 0,
          error: null,
          leaseUntil: null,
          leaseToken: null,
          storageKey: null,
          publicUrl: null,
          requestedAt: sql`now()`,
        })
        .where(and(inProject, eq(videoVersions.id, id), inArray(videoVersions.state, ["failed", "ready"])))
        .returning({ id: videoVersions.id });
      return rows.length > 0;
    },
    async deleteForAsset(assetId) {
      const rows = await db
        .delete(videoVersions)
        .where(and(inProject, eq(videoVersions.mediaAssetId, assetId)))
        .returning({ storageKey: videoVersions.storageKey });
      return rows.map((r) => r.storageKey).filter((k): k is string => k !== null);
    },
    async listCollectable(before, limit) {
      return db
        .select()
        .from(videoVersions)
        .where(and(inProject, sql`${videoVersions.state} <> 'building'`, lt(lastWanted, before)))
        .orderBy(lastWanted)
        .limit(limit);
    },
    async markChecked(ids, at) {
      if (ids.length === 0) return;
      await db.update(videoVersions).set({ checkedAt: at }).where(and(inProject, inArray(videoVersions.id, [...ids])));
    },
    async delete(id) {
      await db.delete(videoVersions).where(and(inProject, eq(videoVersions.id, id)));
    },
  };
}

export type { VideoVersionRow };
