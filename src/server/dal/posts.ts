import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { Database } from "../db/client";
import { postMedia, postStatus, postTargets, posts, type PostRow, type PostTargetStatus } from "../db/schema";

export type PostRecord = PostRow;
export type NewPost = Partial<
  Pick<
    typeof posts.$inferInsert,
    | "baseText"
    | "origin"
    | "generationMetadata"
    | "createdByUserId"
    | "reviewState"
    | "generationRequestId"
    | "schedulingPolicy"
    | "seriesId"
    | "seriesPosition"
  >
>;
export type PostPatch = Partial<
  Pick<
    typeof posts.$inferInsert,
    | "baseText"
    | "reviewState"
    | "generationMetadata"
    | "schedulingPolicy"
    | "reviewedByUserId"
    | "reviewedAt"
    | "rejectionReason"
  >
>;

export const REVIEW_QUEUE_PAGE_SIZE = 50;

export interface PostListFilter {
  status?: PostRecord["status"];
  needsDecision?: boolean;
  limit: number;
  offset: number;
}
export interface PostListRow {
  post: PostRecord;
  /** Next scheduled target time for live posts, else the latest published time; null when neither. */
  relevantAt: Date | null;
  needsDecision: boolean;
  targets: {
    id: string;
    socialAccountId: string;
    status: PostTargetStatus;
    scheduledAt: Date | null;
    publishedAt: Date | null;
  }[];
}

export interface PostsRepo {
  /** Non-deleted posts: live ones by next scheduled time ascending, then the rest by `updated_at` descending. */
  list(filter: PostListFilter): Promise<{ rows: PostListRow[]; total: number }>;
  /** Counts per status plus `needs_decision`, over non-deleted posts. */
  counts(): Promise<Record<PostRecord["status"] | "needs_decision", number>>;
  /** `needs_review`, not deleted, newest first, {@link REVIEW_QUEUE_PAGE_SIZE} per page (1-based). */
  listReviewQueue(page: number): Promise<{ rows: PostRecord[]; total: number }>;
  /** The live post created for this client idempotency key, if any. */
  findByRequestId(generationRequestId: string): Promise<PostRecord | null>;
  /** The live post written for this series angle, if any. */
  findBySeriesPosition(seriesId: string, position: number): Promise<PostRecord | null>;
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
  const needsDecisionExpr = sql<boolean>`EXISTS (SELECT 1 FROM "post_targets" WHERE "post_targets"."project_id" = ${projectId} AND "post_targets"."post_id" = ${posts.id} AND "post_targets"."status" = 'ambiguous')`;
  const nextScheduledExpr = sql<Date | null>`(SELECT min("post_targets"."scheduled_at") FROM "post_targets" WHERE "post_targets"."project_id" = ${projectId} AND "post_targets"."post_id" = ${posts.id} AND "post_targets"."status" IN ('scheduled','publishing'))`;
  return {
    async list(f) {
      const conds: (SQL | undefined)[] = [eq(posts.projectId, projectId), isNull(posts.deletedAt)];
      if (f.status) conds.push(eq(posts.status, f.status));
      if (f.needsDecision) conds.push(needsDecisionExpr);
      const where = and(...conds);
      const [page, [count]] = await Promise.all([
        db
          .select({ post: posts })
          .from(posts)
          .where(where)
          .orderBy(sql`${nextScheduledExpr} ASC NULLS LAST`, desc(posts.updatedAt), desc(posts.id))
          .limit(f.limit)
          .offset(f.offset),
        db.select({ n: sql<number>`count(*)::int` }).from(posts).where(where),
      ]);
      const ids = page.map((p) => p.post.id);
      const targets = ids.length
        ? await db
            .select({
              postId: postTargets.postId,
              id: postTargets.id,
              socialAccountId: postTargets.socialAccountId,
              status: postTargets.status,
              scheduledAt: postTargets.scheduledAt,
              publishedAt: postTargets.publishedAt,
            })
            .from(postTargets)
            .where(and(eq(postTargets.projectId, projectId), inArray(postTargets.postId, ids)))
            .orderBy(asc(postTargets.createdAt), asc(postTargets.id))
        : [];
      const rows = page.map(({ post }): PostListRow => {
        const mine = targets.filter((t) => t.postId === post.id);
        const live = mine
          .filter((t) => (t.status === "scheduled" || t.status === "publishing") && t.scheduledAt)
          .map((t) => t.scheduledAt!.getTime());
        const published = mine.filter((t) => t.publishedAt).map((t) => t.publishedAt!.getTime());
        const at = live.length ? Math.min(...live) : published.length ? Math.max(...published) : null;
        return {
          post,
          relevantAt: at === null ? null : new Date(at),
          needsDecision: mine.some((t) => t.status === "ambiguous"),
          targets: mine.map((t) => ({
            id: t.id,
            socialAccountId: t.socialAccountId,
            status: t.status,
            scheduledAt: t.scheduledAt,
            publishedAt: t.publishedAt,
          })),
        };
      });
      return { rows, total: count?.n ?? 0 };
    },
    async counts() {
      const out = Object.fromEntries([...postStatus.enumValues, "needs_decision"].map((k) => [k, 0])) as Record<
        PostRecord["status"] | "needs_decision",
        number
      >;
      const byStatus = await db
        .select({ status: posts.status, n: sql<number>`count(*)::int` })
        .from(posts)
        .where(and(eq(posts.projectId, projectId), isNull(posts.deletedAt)))
        .groupBy(posts.status);
      for (const r of byStatus) out[r.status] = r.n;
      const [nd] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(posts)
        .where(and(eq(posts.projectId, projectId), isNull(posts.deletedAt), needsDecisionExpr));
      out.needs_decision = nd?.n ?? 0;
      return out;
    },
    async listReviewQueue(page) {
      const where = and(eq(posts.projectId, projectId), eq(posts.reviewState, "needs_review"), isNull(posts.deletedAt));
      const [rows, [count]] = await Promise.all([
        db
          .select()
          .from(posts)
          .where(where)
          .orderBy(desc(posts.createdAt), desc(posts.id))
          .limit(REVIEW_QUEUE_PAGE_SIZE)
          .offset((Math.max(1, page) - 1) * REVIEW_QUEUE_PAGE_SIZE),
        db.select({ n: sql<number>`count(*)::int` }).from(posts).where(where),
      ]);
      return { rows, total: count?.n ?? 0 };
    },
    async findByRequestId(generationRequestId) {
      const [row] = await db
        .select()
        .from(posts)
        .where(
          and(
            eq(posts.projectId, projectId),
            eq(posts.generationRequestId, generationRequestId),
            isNull(posts.deletedAt),
          ),
        )
        .limit(1);
      return row ?? null;
    },
    async findBySeriesPosition(seriesId, position) {
      const [row] = await db
        .select()
        .from(posts)
        .where(
          and(
            eq(posts.projectId, projectId),
            eq(posts.seriesId, seriesId),
            eq(posts.seriesPosition, position),
            isNull(posts.deletedAt),
          ),
        )
        .limit(1);
      return row ?? null;
    },
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
