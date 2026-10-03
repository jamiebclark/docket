import { sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { crossProject } from "./scope";

/** `select 1` through the pool; true when the database answers. */
export async function databaseIsHealthy(): Promise<boolean> {
  try {
    await crossProject("health check", () => getDb().execute(sql`select 1`));
    return true;
  } catch {
    return false;
  }
}
