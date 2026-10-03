import { and, asc, eq, isNull } from "drizzle-orm";
import type { Database } from "../db/client";
import { postMedia, posts, type PostRow } from "../db/schema";

export type PostRecord = PostRow;
export type NewPost = Partial<
  Pick<typeof posts.$inferInsert, "baseText" | "origin" | "generationMetadata" | "createdByUserId" | "reviewState">
>;
export type PostPatch = Partial<
  Pick<typeof posts.$inferInsert, "baseText" | "reviewState" | "generationMetadata">
>;

export interface PostsRepo {
  insert(input: NewPost): Promise<PostRecord>;
  /** Excludes soft-deleted posts. */
  get(id: string): Promise<PostRecord | null>;
  /**
   * `SELECT … FOR UPDATE` as its own statement (research D11): a read in the same statement would
   * use the snapshot taken before the lock was granted.
   */
  lockForUpdate(id: string): Promise<PostRecord | null>;
  update(id: string, patch: PostPatch): Promise<void>;
  /** Replaces the post's media in order (delete, then insert). Call inside a transaction. */
  setMedia(id: string, mediaAssetIds: readonly string[]): Promise<void>;
  listMediaIds(id: string): Promise<string[]>;
  /** Written only by `applyDerivedStatus`. */
  setStatus(id: string, status: PostRecord["status"]): Promise<void>;
  softDelete(id: string, at: Date): Promise<void>;
}

export function createPostsRepo(db: Database, projectId: string): PostsRepo {
  const mine = (id: string) => and(eq(posts.projectId, projectId), eq(posts.id, id));
  return {
    async insert(input) {
      const [row] = await db
        .insert(posts)
        .values({ ...input, projectId })
        .returning();
      return row!;
    },
    async get(id) {
      const [row] = await db
        .select()
        .from(posts)
        .where(and(mine(id), isNull(posts.deletedAt)))
        .limit(1);
      return row ?? null;
    },
    async lockForUpdate(id) {
      const [row] = await db
        .select()
        .from(posts)
        .where(and(mine(id), isNull(posts.deletedAt)))
        .limit(1)
        .for("update");
      return row ?? null;
    },
    async update(id, patch) {
      await db.update(posts).set(patch).where(mine(id));
    },
    async setMedia(id, mediaAssetIds) {
      await db.delete(postMedia).where(and(eq(postMedia.projectId, projectId), eq(postMedia.postId, id)));
      if (mediaAssetIds.length === 0) return;
      await db.insert(postMedia).values(
        mediaAssetIds.map((mediaAssetId, position) => ({
          projectId,
          postId: id,
          mediaAssetId,
          position,
        })),
      );
    },
    async listMediaIds(id) {
      const rows = await db
        .select({ id: postMedia.mediaAssetId })
        .from(postMedia)
        .where(and(eq(postMedia.projectId, projectId), eq(postMedia.postId, id)))
        .orderBy(asc(postMedia.position));
      return rows.map((r) => r.id);
    },
    async setStatus(id, status) {
      await db.update(posts).set({ status }).where(mine(id));
    },
    async softDelete(id, at) {
      await db.update(posts).set({ deletedAt: at }).where(mine(id));
    },
  };
}
