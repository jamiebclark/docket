import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { generationFailures, type GenerationFailureRow } from "../db/schema";

export type GenerationFailureRecord = GenerationFailureRow;
export type NewGenerationFailure = Omit<typeof generationFailures.$inferInsert, "id" | "projectId" | "createdAt">;

export interface GenerationFailuresRepo {
  insert(input: NewGenerationFailure): Promise<GenerationFailureRecord>;
  /** Newest first. */
  listRecent(limit: number): Promise<GenerationFailureRecord[]>;
  /** Newest first. */
  listForSeries(seriesId: string): Promise<GenerationFailureRecord[]>;
}

export function createGenerationFailuresRepo(db: Database, projectId: string): GenerationFailuresRepo {
  return {
    async insert(input) {
      const [row] = await db
        .insert(generationFailures)
        .values({ ...input, projectId })
        .returning();
      return row!;
    },
    async listRecent(limit) {
      return db
        .select()
        .from(generationFailures)
        .where(eq(generationFailures.projectId, projectId))
        .orderBy(desc(generationFailures.createdAt), desc(generationFailures.id))
        .limit(limit);
    },
    async listForSeries(seriesId) {
      return db
        .select()
        .from(generationFailures)
        .where(and(eq(generationFailures.projectId, projectId), eq(generationFailures.seriesId, seriesId)))
        .orderBy(desc(generationFailures.createdAt), desc(generationFailures.id));
    },
  };
}
