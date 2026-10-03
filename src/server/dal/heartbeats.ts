import { getDb } from "../db/client";
import { schedulerHeartbeats } from "../db/schema";

export interface Heartbeat {
  section: string;
  lastSuccessAt: Date;
  lastSummary: Record<string, unknown>;
}

/** Called only when a section completes (FR-039). `scheduler_heartbeats` is not project-owned. */
export async function writeHeartbeat(
  section: string,
  at: Date,
  summary: Record<string, unknown>,
): Promise<void> {
  await getDb()
    .insert(schedulerHeartbeats)
    .values({ section, lastSuccessAt: at, lastSummary: summary, updatedAt: at })
    .onConflictDoUpdate({
      target: schedulerHeartbeats.section,
      set: { lastSuccessAt: at, lastSummary: summary, updatedAt: at },
    });
}

export async function readHeartbeats(): Promise<Heartbeat[]> {
  const rows = await getDb().select().from(schedulerHeartbeats);
  return rows.map((r) => ({
    section: r.section,
    lastSuccessAt: r.lastSuccessAt,
    lastSummary: (r.lastSummary ?? {}) as Record<string, unknown>,
  }));
}

