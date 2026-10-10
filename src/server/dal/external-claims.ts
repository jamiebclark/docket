import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../db/client";
import { externalItemClaims } from "../db/schema";

export interface ExternalClaim {
  sourceKey: string;
  externalId: string;
  postId: string;
  claimedAt: Date;
}

export interface ExternalClaimsRepo {
  /** The claim on one id, or null. Used by the generate pre-check and the runner's pre-check. */
  find(sourceKey: string, externalId: string): Promise<ExternalClaim | null>;
  /** The claims among `externalIds` in one namespace, keyed by external id. One indexed query. */
  findMany(sourceKey: string, externalIds: readonly string[]): Promise<Map<string, ExternalClaim>>;
  /** The claim a post consumed, or null. Behind `Post.source`. */
  findByPostId(postId: string): Promise<ExternalClaim | null>;
  /**
   * Inserts the claim. Throws a unique violation when the id is already claimed — callers recover by
   * re-reading (D7). Call only inside the transaction that inserts the post (FR-007).
   */
  insert(input: { sourceKey: string; externalId: string; postId: string; claimedAt: Date }): Promise<void>;
}

const toClaim = (row: typeof externalItemClaims.$inferSelect): ExternalClaim => ({
  sourceKey: row.sourceKey,
  externalId: row.externalId,
  postId: row.postId,
  claimedAt: row.claimedAt,
});

export function createExternalClaimsRepo(exec: Database, projectId: string): ExternalClaimsRepo {
  const inProject = eq(externalItemClaims.projectId, projectId);
  return {
    async find(sourceKey, externalId) {
      const [row] = await exec
        .select()
        .from(externalItemClaims)
        .where(
          and(
            inProject,
            eq(externalItemClaims.sourceKey, sourceKey),
            eq(externalItemClaims.externalId, externalId),
          ),
        )
        .limit(1);
      return row ? toClaim(row) : null;
    },
    async findMany(sourceKey, externalIds) {
      const out = new Map<string, ExternalClaim>();
      if (externalIds.length === 0) return out;
      const rows = await exec
        .select()
        .from(externalItemClaims)
        .where(
          and(
            inProject,
            eq(externalItemClaims.sourceKey, sourceKey),
            inArray(externalItemClaims.externalId, [...externalIds]),
          ),
        );
      for (const row of rows) out.set(row.externalId, toClaim(row));
      return out;
    },
    async findByPostId(postId) {
      const [row] = await exec
        .select()
        .from(externalItemClaims)
        .where(and(inProject, eq(externalItemClaims.postId, postId)))
        .limit(1);
      return row ? toClaim(row) : null;
    },
    async insert(input) {
      await exec.insert(externalItemClaims).values({ ...input, projectId });
    },
  };
}
