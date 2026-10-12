import { sql } from "drizzle-orm";
import { getDb, type Database } from "../db/client";
import { crossProject } from "./scope";

/**
 * Read-only. Never refreshes, never extends, never writes a cookie (FR-022, S20) — the stream's own
 * re-check, never `auth.api.getSession`. Caller wraps this in
 * `crossProject("notifications stream: session re-check", …)`.
 */
export async function sessionIsLive(db: Database, input: { sessionId: string; userId: string }): Promise<boolean> {
  const result = await db.execute(
    sql`SELECT 1 FROM session WHERE id = ${input.sessionId} AND user_id = ${input.userId} AND expires_at > now()`,
  );
  return result.rows.length > 0;
}

/** The stream's own re-check, with the database and the named cross-project reason already applied. */
export function streamSessionIsLive(input: { sessionId: string; userId: string }): Promise<boolean> {
  return crossProject("notifications stream: session re-check", () => sessionIsLive(getDb(), input));
}
