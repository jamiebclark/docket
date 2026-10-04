import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { generationSeries, type GenerationSeriesRow } from "../db/schema";

export type SeriesRecord = GenerationSeriesRow;

export interface SeriesRepo {
  insert(input: {
    brief: string;
    plan: unknown;
    request: unknown;
    plannedCount: number;
    createdByUserId?: string | null;
  }): Promise<SeriesRecord>;
  get(id: string): Promise<SeriesRecord | null>;
}

export function createSeriesRepo(db: Database, projectId: string): SeriesRepo {
  return {
    async insert(input) {
      const [row] = await db
        .insert(generationSeries)
        .values({
          projectId,
          brief: input.brief,
          plan: input.plan,
          request: input.request,
          plannedCount: input.plannedCount,
          createdByUserId: input.createdByUserId ?? null,
        })
        .returning();
      return row!;
    },
    async get(id) {
      const [row] = await db
        .select()
        .from(generationSeries)
        .where(and(eq(generationSeries.projectId, projectId), eq(generationSeries.id, id)))
        .limit(1);
      return row ?? null;
    },
  };
}
