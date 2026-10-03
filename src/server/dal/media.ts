import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Database } from "../db/client";
import { mediaAssets, type MediaAssetRow } from "../db/schema";

export type MediaRow = MediaAssetRow;
export type NewMedia = Pick<typeof mediaAssets.$inferInsert, "storageKey" | "publicUrl" | "mimeType" | "byteSize"> &
  Partial<Pick<typeof mediaAssets.$inferInsert, "width" | "height" | "altText" | "createdByUserId">>;

export interface MediaRepo {
  insert(input: NewMedia): Promise<MediaRow>;
  get(id: string): Promise<MediaRow | null>;
  getMany(ids: readonly string[]): Promise<MediaRow[]>;
  /** Sets `first_used_at` on assets that have none yet. */
  markUsed(ids: readonly string[], at: Date): Promise<void>;
  updateAlt(id: string, altText: string): Promise<void>;
}

export function createMediaRepo(db: Database, projectId: string): MediaRepo {
  const mine = (id: string) => and(eq(mediaAssets.projectId, projectId), eq(mediaAssets.id, id));
  return {
    async insert(input) {
      const [row] = await db
        .insert(mediaAssets)
        .values({ ...input, projectId })
        .returning();
      return row!;
    },
    async get(id) {
      const [row] = await db.select().from(mediaAssets).where(mine(id)).limit(1);
      return row ?? null;
    },
    async getMany(ids) {
      if (ids.length === 0) return [];
      return db
        .select()
        .from(mediaAssets)
        .where(and(eq(mediaAssets.projectId, projectId), inArray(mediaAssets.id, [...ids])));
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
      await db.update(mediaAssets).set({ altText }).where(mine(id));
    },
  };
}
