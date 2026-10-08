import { and, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { createSchedulingRepos } from "./scope";
import { videoVersions, type VideoVersionRow } from "../db/schema";

/**
 * Cross-project housekeeping: rows nobody has wanted since `before`, never a `building` one, oldest first.
 * Call only inside `crossProject("housekeeping: collect video versions", …)`.
 */
export async function listCollectableVideoVersions(before: Date, limit: number): Promise<VideoVersionRow[]> {
  const lastWanted = sql`GREATEST(${videoVersions.checkedAt}, ${videoVersions.requestedAt})`;
  return getDb()
    .select()
    .from(videoVersions)
    .where(and(sql`${videoVersions.state} <> 'building'`, sql`${lastWanted} < ${before}`))
    .orderBy(lastWanted)
    .limit(limit);
}

/** The scheduling repositories of one project, for housekeeping to plan what its posts still want. */
export const reposForProject = (projectId: string) => createSchedulingRepos(getDb(), projectId);
