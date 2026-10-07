import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { mediaUploads, type MediaUploadRow } from "../db/schema";

export type UploadRow = MediaUploadRow;
export type UploadState = UploadRow["state"];
export type NewUpload = Pick<
  typeof mediaUploads.$inferInsert,
  | "createdByUserId"
  | "filename"
  | "kind"
  | "declaredType"
  | "declaredBytes"
  | "partSize"
  | "partCount"
  | "transport"
  | "storageKey"
> &
  Partial<Pick<typeof mediaUploads.$inferInsert, "id">>;

export interface UploadPatch {
  storageUploadId?: string | null;
  mediaAssetId?: string | null;
  error?: string | null;
}

const OPEN_STATES = ["open", "completing"] as const;
const TERMINAL_STATES = new Set<string>(["completed", "refused", "cancelled", "expired"]);

/** Upload sessions of one project. Every method is also pinned to the member who created the session. */
export interface UploadsRepo {
  insert(input: NewUpload): Promise<UploadRow>;
  /** A live session of this project and member; null for anyone else's, so it never reveals that it exists. */
  getOwned(id: string, userId: string): Promise<UploadRow | null>;
  /** `FOR UPDATE` in its own statement (002 D11 rule); only meaningful inside a transaction. */
  lockOwned(id: string, userId: string): Promise<UploadRow | null>;
  /** The member's `open` and `completing` sessions, for the per-member cap. */
  countOpenFor(userId: string): Promise<number>;
  /** Conditional update: moves the session only when it is in one of `from`. False when it was not. */
  transition(id: string, from: readonly UploadState[], to: UploadState, patch?: UploadPatch): Promise<boolean>;
  /** The member's open and completing sessions, oldest first. */
  listOpenFor(userId: string): Promise<UploadRow[]>;
}

export function createUploadsRepo(db: Database, projectId: string): UploadsRepo {
  const inProject = eq(mediaUploads.projectId, projectId);
  const owned = (id: string, userId: string) =>
    and(inProject, eq(mediaUploads.id, id), eq(mediaUploads.createdByUserId, userId));
  return {
    async insert(input) {
      const [row] = await db
        .insert(mediaUploads)
        .values({ ...input, projectId })
        .returning();
      return row!;
    },
    async getOwned(id, userId) {
      const [row] = await db.select().from(mediaUploads).where(owned(id, userId)).limit(1);
      return row ?? null;
    },
    async lockOwned(id, userId) {
      const [row] = await db.select().from(mediaUploads).where(owned(id, userId)).limit(1).for("update");
      return row ?? null;
    },
    async countOpenFor(userId) {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(mediaUploads)
        .where(
          and(inProject, eq(mediaUploads.createdByUserId, userId), inArray(mediaUploads.state, [...OPEN_STATES])),
        );
      return row?.n ?? 0;
    },
    async transition(id, from, to, patch = {}) {
      const rows = await db
        .update(mediaUploads)
        .set({ ...patch, state: to, ...(TERMINAL_STATES.has(to) ? { finishedAt: new Date() } : {}) })
        .where(and(inProject, eq(mediaUploads.id, id), inArray(mediaUploads.state, [...from])))
        .returning({ id: mediaUploads.id });
      return rows.length > 0;
    },
    async listOpenFor(userId) {
      return db
        .select()
        .from(mediaUploads)
        .where(
          and(inProject, eq(mediaUploads.createdByUserId, userId), inArray(mediaUploads.state, [...OPEN_STATES])),
        )
        .orderBy(asc(mediaUploads.createdAt), asc(mediaUploads.id));
    },
  };
}
