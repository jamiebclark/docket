import { sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { crossProject } from "./scope";

/**
 * Worker start-up probe (research D17): true once the scheduler tables and columns exist.
 * False on `42P01` (missing table), `42703` (missing column) and connection errors.
 */
export async function schemaIsReady(): Promise<boolean> {
  try {
    await getDb().execute(
      sql`select section, last_success_at from scheduler_heartbeats limit 1`,
    );
    await crossProject("worker: schema probe", async () =>
      await getDb().execute(sql`select slot_occurrence_at, lease_owner from post_targets limit 1`),
    );
    return true;
  } catch {
    return false;
  }
}
