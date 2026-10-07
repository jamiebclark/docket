import { and, asc, eq, inArray } from "drizzle-orm";
import type { Database } from "../db/client";
import { publishAttempts, type PublishAttemptRow } from "../db/schema";

export type AttemptRow = PublishAttemptRow;
export type AttemptOutcome = AttemptRow["outcome"];

export interface AttemptEntry {
  postTargetId: string;
  step: string;
  outcome: AttemptOutcome;
  requestSummary?: Record<string, unknown>;
  responseSummary?: Record<string, unknown>;
  error?: string | null;
  durationMs?: number | null;
  tickId?: string | null;
  actorUserId?: string | null;
  actorApiKeyId?: string | null;
  /** The clock's `now`, so tests and the engine agree on time. */
  at: Date;
}

/** Append-only by design: insert and list, nothing else (FR-006). */
export interface AttemptsRepo {
  insert(entry: AttemptEntry): Promise<void>;
  listForTarget(postTargetId: string): Promise<AttemptRow[]>;
  /** Attempts of every given target, in `created_at, id` order. */
  listForTargets(postTargetIds: readonly string[]): Promise<AttemptRow[]>;
}

export function createAttemptsRepo(db: Database, projectId: string): AttemptsRepo {
  return {
    async insert(entry) {
      await db.insert(publishAttempts).values({
        projectId,
        postTargetId: entry.postTargetId,
        step: entry.step,
        outcome: entry.outcome,
        requestSummary: entry.requestSummary ?? {},
        responseSummary: entry.responseSummary ?? {},
        error: entry.error ?? null,
        durationMs: entry.durationMs ?? null,
        tickId: entry.tickId ?? null,
        actorUserId: entry.actorUserId ?? null,
        actorApiKeyId: entry.actorApiKeyId ?? null,
        createdAt: entry.at,
      });
    },
    async listForTargets(postTargetIds) {
      if (postTargetIds.length === 0) return [];
      return db
        .select()
        .from(publishAttempts)
        .where(
          and(
            eq(publishAttempts.projectId, projectId),
            inArray(publishAttempts.postTargetId, [...postTargetIds]),
          ),
        )
        .orderBy(asc(publishAttempts.createdAt), asc(publishAttempts.id));
    },
    async listForTarget(postTargetId) {
      return db
        .select()
        .from(publishAttempts)
        .where(
          and(eq(publishAttempts.projectId, projectId), eq(publishAttempts.postTargetId, postTargetId)),
        )
        .orderBy(asc(publishAttempts.createdAt), asc(publishAttempts.id));
    },
  };
}
