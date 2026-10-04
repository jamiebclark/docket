import { and, asc, desc, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  mediaAssets,
  mediaVariants,
  postMedia,
  postTargets,
  posts,
  type MediaAssetRow,
  type MediaVariantRow,
  type PostTargetStatus,
} from "../db/schema";

export type MediaRow = MediaAssetRow;
export type NewMedia = Pick<typeof mediaAssets.$inferInsert, "storageKey" | "publicUrl" | "mimeType" | "byteSize"> &
  Partial<
    Pick<
      typeof mediaAssets.$inferInsert,
      | "width"
      | "height"
      | "altText"
      | "createdByUserId"
      | "thumbnailStorageKey"
      | "thumbnailUrl"
      | "originalFilename"
      | "tags"
      | "id"
    >
  >;
export type VariantRow = MediaVariantRow;
export type NewVariant = Omit<typeof mediaVariants.$inferInsert, "id" | "projectId" | "createdAt">;
export interface MediaListFilter {
  tag?: string;
  unused?: boolean;
  missingAlt?: boolean;
  q?: string;
  limit: number;
  offset: number;
}

export interface MediaSelectionFilter {
  tag?: string;
  missingAlt?: boolean;
  q?: string;
  /** Exclude used and reserved assets. */
  unusedOnly?: boolean;
  /** `false` excludes used assets (reserved ones stay; creation drops them under the lock). */
  includeUsed?: boolean;
  limit: number;
}

export interface MediaRepo {
  insert(input: NewMedia): Promise<MediaRow>;
  get(id: string): Promise<MediaRow | null>;
  getMany(ids: readonly string[]): Promise<MediaRow[]>;
  /** Sets `first_used_at` on assets that have none yet. */
  markUsed(ids: readonly string[], at: Date): Promise<void>;
  updateAlt(id: string, altText: string): Promise<void>;
  getIncludingDeleted(id: string): Promise<MediaRow | null>;
  list(
    filter: MediaListFilter,
  ): Promise<{ rows: (MediaRow & { inUse: boolean; reservedByJobId: string | null })[]; total: number }>;
  /** Live asset ids matching the library filters, newest first. `unusedOnly` also drops reserved assets. */
  listIdsForSelection(filter: MediaSelectionFilter): Promise<string[]>;
  /**
   * `FOR NO KEY UPDATE`, live assets only, in id order, in its own statement. Serialises job creations
   * that want the same images; it does not block `FOR SHARE` readers' foreign-key checks.
   */
  lockForReservation(ids: readonly string[]): Promise<MediaRow[]>;
  /** The subset of `ids` held by a queued, running or failed job item. */
  reservedAmong(ids: readonly string[]): Promise<string[]>;
  /** The subset of `ids` with `first_used_at` set. */
  usedAmong(ids: readonly string[]): Promise<string[]>;
  /** Distinct tags of live assets, sorted. */
  listTags(): Promise<string[]>;
  update(id: string, patch: { altText?: string; tags?: string[] }): Promise<MediaRow | null>;
  /** `FOR UPDATE` in its own statement (002 D11 rule). Includes deleted rows so a delete can be idempotent. */
  lockForUpdate(id: string): Promise<MediaRow | null>;
  /** `FOR SHARE`, live assets only, in id order so concurrent lockers cannot deadlock. */
  lockShared(ids: readonly string[]): Promise<MediaRow[]>;
  postsUsing(id: string): Promise<{ postId: string; targetStatuses: PostTargetStatus[] }[]>;
  softDelete(id: string, at: Date): Promise<void>;
  /** Removes the asset from the given posts and renumbers the remaining positions. */
  detachFromPosts(id: string, postIds: readonly string[]): Promise<void>;
  getVariant(assetId: string, hash: string): Promise<VariantRow | null>;
  listVariants(assetId: string): Promise<VariantRow[]>;
  /** `ON CONFLICT DO NOTHING`, then a re-select when a concurrent insert won. */
  insertVariant(row: NewVariant): Promise<VariantRow>;
  deleteVariants(assetId: string): Promise<VariantRow[]>;
}

const escapeLike = (v: string) => v.replace(/[\\%_]/g, (c) => `\\${c}`);

export function createMediaRepo(db: Database, projectId: string): MediaRepo {
  const inProject = eq(mediaAssets.projectId, projectId);
  const live = and(inProject, isNull(mediaAssets.deletedAt));
  const mine = (id: string) => and(inProject, eq(mediaAssets.id, id));
  const mineLive = (id: string) => and(live, eq(mediaAssets.id, id));
  // A job item that still holds the asset (research D15): the same predicate as the partial unique index.
  // Qualified, because a bare column inside a one-table select would resolve to the subquery's own table.
  const assetId = sql.raw('"media_assets"."id"');
  // A job item that still holds the asset (research D15): the same predicate as the partial unique index.
  const reservedJobExpr = sql<string | null>`(SELECT i."job_id" FROM "generation_job_items" i WHERE i."project_id" = ${projectId} AND i."media_asset_id" = ${assetId} AND i."status" IN ('queued','running','failed') LIMIT 1)`;
  // Counts, not NOT EXISTS: the scope checker rejects any negation in a predicate.
  const reservations = sql`(SELECT count(*) FROM "generation_job_items" i WHERE i."project_id" = ${projectId} AND i."media_asset_id" = ${assetId} AND i."status" IN ('queued','running','failed'))`;
  const notReserved = sql`${reservations} = 0`;
  const searchCond = (f: { tag?: string; missingAlt?: boolean; q?: string }) => {
    const conds: (SQL | undefined)[] = [];
    if (f.tag) conds.push(sql`${f.tag} = ANY(${mediaAssets.tags})`);
    if (f.missingAlt) conds.push(sql`btrim(${mediaAssets.altText}) = ''`);
    if (f.q) {
      const pat = `%${escapeLike(f.q)}%`;
      // One expression, not OR: the scope checker rejects any `or` in a predicate. chr(1) never appears in a pattern.
      conds.push(sql`concat_ws(chr(1), ${mediaAssets.altText}, ${mediaAssets.originalFilename}) ILIKE ${pat}`);
    }
    return conds;
  };
  const myVariant = (assetId: string) =>
    and(eq(mediaVariants.projectId, projectId), eq(mediaVariants.mediaAssetId, assetId));
  return {
    async insert(input) {
      const [row] = await db
        .insert(mediaAssets)
        .values({ ...input, projectId })
        .returning();
      return row!;
    },
    async get(id) {
      const [row] = await db.select().from(mediaAssets).where(mineLive(id)).limit(1);
      return row ?? null;
    },
    async getIncludingDeleted(id) {
      const [row] = await db.select().from(mediaAssets).where(mine(id)).limit(1);
      return row ?? null;
    },
    async getMany(ids) {
      if (ids.length === 0) return [];
      return db
        .select()
        .from(mediaAssets)
        .where(and(live, inArray(mediaAssets.id, [...ids])));
    },
    async markUsed(ids, at) {
      if (ids.length === 0) return;
      await db
        .update(mediaAssets)
        .set({ firstUsedAt: at })
        .where(
          and(
            eq(mediaAssets.projectId, projectId),
            inArray(mediaAssets.id, [...ids]),
            isNull(mediaAssets.firstUsedAt),
          ),
        );
    },
    async updateAlt(id, altText) {
      await db.update(mediaAssets).set({ altText }).where(mineLive(id));
    },
    async list(f) {
      const conds: (SQL | undefined)[] = [inProject, isNull(mediaAssets.deletedAt), ...searchCond(f)];
      if (f.unused) conds.push(isNull(mediaAssets.firstUsedAt), notReserved);
      const where = and(...conds);
      const [rows, [count]] = await Promise.all([
        db
          .select({ asset: mediaAssets, reservedByJobId: reservedJobExpr })
          .from(mediaAssets)
          .where(where)
          .orderBy(desc(mediaAssets.createdAt), desc(mediaAssets.id))
          .limit(f.limit)
          .offset(f.offset),
        db.select({ n: sql<number>`count(*)::int` }).from(mediaAssets).where(where),
      ]);
      return {
        rows: rows.map((r) => ({
          ...r.asset,
          inUse: r.asset.firstUsedAt !== null,
          reservedByJobId: r.reservedByJobId,
        })),
        total: count?.n ?? 0,
      };
    },
    async listIdsForSelection(f) {
      const conds: (SQL | undefined)[] = [live, ...searchCond(f)];
      if (f.unusedOnly) conds.push(isNull(mediaAssets.firstUsedAt), notReserved);
      else if (f.includeUsed === false) conds.push(isNull(mediaAssets.firstUsedAt));
      const rows = await db
        .select({ id: mediaAssets.id })
        .from(mediaAssets)
        .where(and(...conds))
        .orderBy(desc(mediaAssets.createdAt), desc(mediaAssets.id))
        .limit(f.limit);
      return rows.map((r) => r.id);
    },
    async lockForReservation(ids) {
      if (ids.length === 0) return [];
      return db
        .select()
        .from(mediaAssets)
        .where(and(live, inArray(mediaAssets.id, [...ids])))
        .orderBy(asc(mediaAssets.id))
        .for("no key update");
    },
    async reservedAmong(ids) {
      if (ids.length === 0) return [];
      const rows = await db
        .select({ id: mediaAssets.id })
        .from(mediaAssets)
        .where(and(inProject, inArray(mediaAssets.id, [...ids]), sql`${reservations} > 0`));
      return rows.map((r) => r.id);
    },
    async usedAmong(ids) {
      if (ids.length === 0) return [];
      const rows = await db
        .select({ id: mediaAssets.id })
        .from(mediaAssets)
        .where(and(inProject, inArray(mediaAssets.id, [...ids]), isNotNull(mediaAssets.firstUsedAt)));
      return rows.map((r) => r.id);
    },
    async listTags() {
      const res = await db.execute<{ tag: string }>(
        sql`SELECT DISTINCT unnest(tags) AS tag FROM media_assets WHERE project_id = ${projectId} AND deleted_at IS NULL ORDER BY tag`,
      );
      return res.rows.map((r) => r.tag);
    },
    async update(id, patch) {
      const set: Partial<typeof mediaAssets.$inferInsert> = {};
      if (patch.altText !== undefined) set.altText = patch.altText;
      if (patch.tags !== undefined) set.tags = patch.tags;
      if (Object.keys(set).length === 0) return this.get(id);
      const [row] = await db.update(mediaAssets).set(set).where(mineLive(id)).returning();
      return row ?? null;
    },
    async lockForUpdate(id) {
      const [row] = await db.select().from(mediaAssets).where(mine(id)).limit(1).for("update");
      return row ?? null;
    },
    async lockShared(ids) {
      if (ids.length === 0) return [];
      return db
        .select()
        .from(mediaAssets)
        .where(and(live, inArray(mediaAssets.id, [...ids])))
        .orderBy(asc(mediaAssets.id))
        .for("share");
    },
    async postsUsing(id) {
      const rows = await db
        .select({ postId: postMedia.postId, status: postTargets.status })
        .from(postMedia)
        .innerJoin(posts, and(eq(posts.id, postMedia.postId), eq(posts.projectId, postMedia.projectId)))
        .leftJoin(
          postTargets,
          and(eq(postTargets.postId, posts.id), eq(postTargets.projectId, posts.projectId)),
        )
        .where(and(eq(postMedia.projectId, projectId), eq(postMedia.mediaAssetId, id)));
      const byPost = new Map<string, PostTargetStatus[]>();
      for (const r of rows) {
        const list = byPost.get(r.postId) ?? [];
        if (r.status) list.push(r.status);
        byPost.set(r.postId, list);
      }
      return [...byPost].map(([postId, targetStatuses]) => ({ postId, targetStatuses }));
    },
    async softDelete(id, at) {
      await db.update(mediaAssets).set({ deletedAt: at }).where(and(mine(id), isNull(mediaAssets.deletedAt)));
    },
    async detachFromPosts(id, postIds) {
      for (const postId of postIds) {
        await db
          .delete(postMedia)
          .where(
            and(eq(postMedia.projectId, projectId), eq(postMedia.postId, postId), eq(postMedia.mediaAssetId, id)),
          );
        const rest = await db
          .select({ assetId: postMedia.mediaAssetId, position: postMedia.position })
          .from(postMedia)
          .where(and(eq(postMedia.projectId, projectId), eq(postMedia.postId, postId)))
          .orderBy(asc(postMedia.position));
        // Ascending order: each row moves into a slot an earlier row already vacated.
        for (const [i, r] of rest.entries()) {
          if (r.position === i) continue;
          await db
            .update(postMedia)
            .set({ position: i })
            .where(
              and(
                eq(postMedia.projectId, projectId),
                eq(postMedia.postId, postId),
                eq(postMedia.mediaAssetId, r.assetId),
              ),
            );
        }
      }
    },
    async getVariant(assetId, hash) {
      const [row] = await db
        .select()
        .from(mediaVariants)
        .where(and(myVariant(assetId), eq(mediaVariants.constraintsHash, hash)))
        .limit(1);
      return row ?? null;
    },
    async listVariants(assetId) {
      return db.select().from(mediaVariants).where(myVariant(assetId)).orderBy(asc(mediaVariants.createdAt));
    },
    async insertVariant(row) {
      const [ins] = await db
        .insert(mediaVariants)
        .values({ ...row, projectId })
        .onConflictDoNothing({ target: [mediaVariants.mediaAssetId, mediaVariants.constraintsHash] })
        .returning();
      if (ins) return ins;
      const [existing] = await db
        .select()
        .from(mediaVariants)
        .where(and(myVariant(row.mediaAssetId), eq(mediaVariants.constraintsHash, row.constraintsHash)))
        .limit(1);
      return existing!;
    },
    async deleteVariants(assetId) {
      return db.delete(mediaVariants).where(myVariant(assetId)).returning();
    },
  };
}
