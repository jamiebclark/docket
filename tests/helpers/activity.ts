import { asc, eq } from "drizzle-orm";
import { activityEvents } from "../../src/server/db/schema/activity";
import { testDb } from "./db";

/** Every activity row of a project, oldest first, read straight from the table. */
export function eventsFor(projectId: string) {
  return testDb().select().from(activityEvents).where(eq(activityEvents.projectId, projectId)).orderBy(asc(activityEvents.seq));
}

/** The rows as one string, for "this secret appears nowhere" assertions (bigint `seq` survives). */
export function dump(rows: unknown): string {
  return JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}
