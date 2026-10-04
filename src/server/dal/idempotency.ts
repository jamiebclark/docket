import { randomUUID } from "node:crypto";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { getDb, type Database } from "../db/client";
import { apiIdempotencyKeys } from "../db/schema";
import { now } from "./clock";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RETRY_AFTER_SECONDS = 60;

export interface ClaimInput {
  apiKeyId: string;
  method: string;
  route: string;
  idemKey: string;
  bodyHash: string;
  holdMs: number;
}

export type ClaimResult =
  | { kind: "claimed"; recordId: string; token: string }
  | { kind: "replay"; status: number; body: unknown }
  | { kind: "mismatch" }
  | { kind: "in_progress"; retryAfterSeconds: number };

export interface IdempotencyRepo {
  claim(input: ClaimInput): Promise<ClaimResult>;
  /** Conditional on the lock token; false means the hold was lost. */
  complete(recordId: string, token: string, status: number, body: unknown): Promise<boolean>;
  /** Deletes the claim if this token still holds it, so the key can be used again. */
  release(recordId: string, token: string): Promise<void>;
}

export function createIdempotencyRepo(db: Database, projectId: string): IdempotencyRepo {
  const t = apiIdempotencyKeys;
  return {
    async claim(input) {
      const at = await now();
      const token = randomUUID();
      const holdUntil = new Date(at.getTime() + input.holdMs);
      const expiresAt = new Date(at.getTime() + RETENTION_MS);
      const key = and(
        eq(t.projectId, projectId),
        eq(t.apiKeyId, input.apiKeyId),
        eq(t.method, input.method),
        eq(t.route, input.route),
        eq(t.idemKey, input.idemKey),
      );

      const inserted = await db
        .insert(t)
        .values({
          projectId,
          apiKeyId: input.apiKeyId,
          method: input.method,
          route: input.route,
          idemKey: input.idemKey,
          bodyHash: input.bodyHash,
          state: "in_progress",
          lockToken: token,
          holdUntil,
          expiresAt,
          createdAt: at,
        })
        .onConflictDoNothing()
        .returning({ id: t.id });
      if (inserted[0]) return { kind: "claimed", recordId: inserted[0].id, token };

      const rows = await db.select().from(t).where(key).limit(1);
      const row = rows[0];
      // The row vanished between the two statements (released): claim again from scratch.
      if (!row) return this.claim(input);

      const lapsed =
        row.expiresAt.getTime() <= at.getTime() || (row.state === "in_progress" && row.holdUntil!.getTime() <= at.getTime());
      if (!lapsed) {
        if (row.bodyHash !== input.bodyHash) return { kind: "mismatch" };
        if (row.state === "completed") return { kind: "replay", status: row.responseStatus!, body: row.responseBody };
        const seconds = Math.ceil((row.holdUntil!.getTime() - at.getTime()) / 1000);
        return { kind: "in_progress", retryAfterSeconds: Math.min(Math.max(seconds, 1), MAX_RETRY_AFTER_SECONDS) };
      }

      const taken = await db
        .update(t)
        .set({
          state: "in_progress",
          lockToken: token,
          holdUntil,
          bodyHash: input.bodyHash,
          responseStatus: null,
          responseBody: null,
          completedAt: null,
          createdAt: at,
          expiresAt,
        })
        .where(
          and(
            eq(t.projectId, projectId),
            eq(t.id, row.id),
            // Past retention, or an in-progress hold that lapsed. Written without OR so the scope check can see the project pin.
            lte(sql`least(${t.expiresAt}, coalesce(${t.holdUntil}, ${t.expiresAt}))`, at),
          ),
        )
        .returning({ id: t.id });
      if (taken[0]) return { kind: "claimed", recordId: taken[0].id, token };
      return { kind: "in_progress", retryAfterSeconds: 1 };
    },

    async complete(recordId, token, status, body) {
      const at = await now();
      const rows = await db
        .update(t)
        .set({
          state: "completed",
          lockToken: null,
          holdUntil: null,
          responseStatus: status,
          responseBody: body ?? null,
          completedAt: at,
        })
        .where(and(eq(t.projectId, projectId), eq(t.id, recordId), eq(t.lockToken, token), eq(t.state, "in_progress")))
        .returning({ id: t.id });
      return rows.length === 1;
    },

    async release(recordId, token) {
      await db.delete(t).where(and(eq(t.projectId, projectId), eq(t.id, recordId), eq(t.lockToken, token)));
    },
  };
}

/** Housekeeping across projects; callers wrap this in `crossProject`. */
export async function purgeExpiredIdempotency(db: Database, limit: number): Promise<number> {
  const at = await now();
  const ids = await db
    .select({ id: apiIdempotencyKeys.id })
    .from(apiIdempotencyKeys)
    .where(lte(apiIdempotencyKeys.expiresAt, at))
    .limit(limit);
  if (ids.length === 0) return 0;
  const gone = await db
    .delete(apiIdempotencyKeys)
    .where(
      inArray(
        apiIdempotencyKeys.id,
        ids.map((r) => r.id),
      ),
    )
    .returning({ id: apiIdempotencyKeys.id });
  return gone.length;
}

/** Housekeeping entry point for the scheduler, which may not hold the database client. */
export function purgeExpiredIdempotencyKeys(limit: number): Promise<number> {
  return purgeExpiredIdempotency(getDb(), limit);
}
