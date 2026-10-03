import { and, asc, eq, gte, inArray, isNotNull, lte, gt } from "drizzle-orm";
import type { Database } from "../db/client";
import { mediaAssets, postMedia, postTargets, posts, type PostTargetRow } from "../db/schema";

export type TargetRecord = PostTargetRow;
export type TargetStatus = TargetRecord["status"];
export type TargetPatch = Partial<Omit<typeof postTargets.$inferInsert, "id" | "projectId" | "postId" | "socialAccountId">>;
export type NewTarget = Pick<typeof postTargets.$inferInsert, "postId" | "socialAccountId"> & TargetPatch;

/** An extra condition on `update`: the row only changes if it still has one of these statuses / this lease. */
export interface TargetGuard {
  statuses?: readonly TargetStatus[];
  leaseOwner?: string;
}

export interface EffectiveContent {
  text: string;
  media: {
    url: string;
    mimeType: string;
    width: number | null;
    height: number | null;
    bytes: number;
    altText: string;
  }[];
}

export interface TargetsRepo {
  listForPost(postId: string): Promise<TargetRecord[]>;
  get(id: string): Promise<TargetRecord | null>;
  /** Locks every target row of the post (`FOR UPDATE`, its own statement), waiting out a claim in flight. */
  lockForPost(postId: string): Promise<TargetRecord[]>;
  insertMany(rows: readonly NewTarget[]): Promise<TargetRecord[]>;
  /** Returns the updated row, or `null` when the guard did not match. */
  update(id: string, patch: TargetPatch, guard?: TargetGuard): Promise<TargetRecord | null>;
  /** Instants held on the account in `[from, to]`. */
  heldInstants(accountId: string, from: Date, to: Date): Promise<Date[]>;
  /**
   * Takes the occurrence for the target inside a savepoint. `false` when another target holds it
   * (unique violation `23505`); the surrounding transaction stays usable. Also stamps the schedule
   * columns the `post_targets` checks tie to a held occurrence.
   */
  tryHoldOccurrence(targetId: string, instant: Date, slotId: string): Promise<boolean>;
  releaseOccurrence(targetId: string): Promise<void>;
  /** Slot-queued, future, scheduled targets of an account, locked in `scheduled_at, id` order. */
  queuedForAccount(accountId: string, after: Date): Promise<TargetRecord[]>;
  /** Scheduled targets of the account within `windowMs` of `instant`. */
  nearScheduled(accountId: string, instant: Date, windowMs: number): Promise<TargetRecord[]>;
  effectiveContent(targetId: string): Promise<EffectiveContent | null>;
  /** Targets of the account still in play (`draft`, `scheduled`, `publishing`), ordered by id. */
  listOpenForAccount(accountId: string): Promise<TargetRecord[]>;
}

function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}

export function createTargetsRepo(db: Database, projectId: string): TargetsRepo {
  const mine = (id: string) => and(eq(postTargets.projectId, projectId), eq(postTargets.id, id));
  return {
    async listForPost(postId) {
      return db
        .select()
        .from(postTargets)
        .where(and(eq(postTargets.projectId, projectId), eq(postTargets.postId, postId)))
        .orderBy(asc(postTargets.createdAt), asc(postTargets.id));
    },
    async lockForPost(postId) {
      return db
        .select()
        .from(postTargets)
        .where(and(eq(postTargets.projectId, projectId), eq(postTargets.postId, postId)))
        .orderBy(asc(postTargets.id))
        .for("update");
    },
    async get(id) {
      const [row] = await db.select().from(postTargets).where(mine(id)).limit(1);
      return row ?? null;
    },
    async insertMany(rows) {
      if (rows.length === 0) return [];
      return db
        .insert(postTargets)
        .values(rows.map((r) => ({ ...r, projectId })))
        .returning();
    },
    async update(id, patch, guard) {
      const conditions = [mine(id)];
      if (guard?.statuses) conditions.push(inArray(postTargets.status, [...guard.statuses]));
      if (guard?.leaseOwner) conditions.push(eq(postTargets.leaseOwner, guard.leaseOwner));
      const [row] = await db
        .update(postTargets)
        .set(patch)
        .where(and(...conditions))
        .returning();
      return row ?? null;
    },
    async heldInstants(accountId, from, to) {
      const rows = await db
        .select({ at: postTargets.slotOccurrenceAt })
        .from(postTargets)
        .where(
          and(
            eq(postTargets.projectId, projectId),
            eq(postTargets.socialAccountId, accountId),
            isNotNull(postTargets.slotOccurrenceAt),
            gte(postTargets.slotOccurrenceAt, from),
            lte(postTargets.slotOccurrenceAt, to),
          ),
        );
      return rows.map((r) => r.at!);
    },
    async tryHoldOccurrence(targetId, instant, slotId) {
      try {
        await db.transaction(async (sp) => {
          await sp
            .update(postTargets)
            .set({
              slotOccurrenceAt: instant,
              slotId,
              scheduleKind: "slot",
              scheduledAt: instant,
              nextAttemptAt: instant,
            })
            .where(mine(targetId));
        });
        return true;
      } catch (error) {
        if (isUniqueViolation(error)) return false;
        throw error;
      }
    },
    async releaseOccurrence(targetId) {
      await db.update(postTargets).set({ slotOccurrenceAt: null, slotId: null }).where(mine(targetId));
    },
    async queuedForAccount(accountId, after) {
      return db
        .select()
        .from(postTargets)
        .where(
          and(
            eq(postTargets.projectId, projectId),
            eq(postTargets.socialAccountId, accountId),
            eq(postTargets.status, "scheduled"),
            eq(postTargets.scheduleKind, "slot"),
            gt(postTargets.scheduledAt, after),
          ),
        )
        .orderBy(asc(postTargets.scheduledAt), asc(postTargets.id))
        .for("update");
    },
    async nearScheduled(accountId, instant, windowMs) {
      return db
        .select()
        .from(postTargets)
        .where(
          and(
            eq(postTargets.projectId, projectId),
            eq(postTargets.socialAccountId, accountId),
            eq(postTargets.status, "scheduled"),
            gte(postTargets.scheduledAt, new Date(instant.getTime() - windowMs)),
            lte(postTargets.scheduledAt, new Date(instant.getTime() + windowMs)),
          ),
        )
        .orderBy(asc(postTargets.scheduledAt), asc(postTargets.id));
    },
    async listOpenForAccount(accountId) {
      return db
        .select()
        .from(postTargets)
        .where(
          and(
            eq(postTargets.projectId, projectId),
            eq(postTargets.socialAccountId, accountId),
            inArray(postTargets.status, ["draft", "scheduled", "publishing"]),
          ),
        )
        .orderBy(asc(postTargets.id));
    },
    async effectiveContent(targetId) {
      const [head] = await db
        .select({ overrideText: postTargets.overrideText, baseText: posts.baseText, postId: posts.id })
        .from(postTargets)
        .innerJoin(
          posts,
          and(eq(posts.id, postTargets.postId), eq(posts.projectId, postTargets.projectId)),
        )
        .where(and(eq(postTargets.projectId, projectId), eq(postTargets.id, targetId)))
        .limit(1);
      if (!head) return null;
      const media = await db
        .select({
          url: mediaAssets.publicUrl,
          mimeType: mediaAssets.mimeType,
          width: mediaAssets.width,
          height: mediaAssets.height,
          bytes: mediaAssets.byteSize,
          altText: mediaAssets.altText,
        })
        .from(postMedia)
        .innerJoin(
          mediaAssets,
          and(eq(mediaAssets.id, postMedia.mediaAssetId), eq(mediaAssets.projectId, postMedia.projectId)),
        )
        .where(and(eq(postMedia.projectId, projectId), eq(postMedia.postId, head.postId)))
        .orderBy(asc(postMedia.position));
      return { text: head.overrideText ?? head.baseText, media };
    },
  };
}
