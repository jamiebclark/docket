import { sql } from "drizzle-orm";
import { getDb, type Database } from "../db/client";
import { crossProject } from "./scope";

/** Opaque; compare with `===`. Never ordered, never parsed (data-model.md §2). */
export interface ChangeFingerprint {
  readonly value: string;
}

// Literal, never a parameter, so the planner matches the partial index's predicate (data-model.md §1).
const ATTENTION_OUTCOMES = sql.raw("'failed', 'ambiguous', 'needs_reauth', 'connect_failed'");

/**
 * The nine install-wide scalars in one statement, folded into one opaque string (data-model.md §2).
 * Caller wraps this in `crossProject("notifications stream: install probe", …)`.
 */
export async function readChangeFingerprint(db: Database): Promise<ChangeFingerprint> {
  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT
      (SELECT max(seq)::text FROM activity_events
         WHERE outcome IN (${ATTENTION_OUTCOMES}))                AS attention_seq,
      (SELECT count(*)::int        FROM notification_states)      AS states_n,
      (SELECT max(updated_at)      FROM notification_states)      AS states_at,
      (SELECT count(*)::int        FROM notification_preferences) AS prefs_n,
      (SELECT max(updated_at)      FROM notification_preferences) AS prefs_at,
      (SELECT count(*)::int        FROM notification_event_marks) AS marks_n,
      (SELECT max(updated_at)      FROM notification_event_marks) AS marks_at,
      (SELECT count(*)::int        FROM member)                   AS members_n,
      (SELECT max(created_at)      FROM member)                   AS members_at
  `);
  const row = result.rows[0] ?? {};
  return { value: JSON.stringify(row) };
}

/** The watcher's own probe, with the database and the named cross-project reason already applied. */
export function probeChangeFingerprint(): Promise<ChangeFingerprint> {
  return crossProject("notifications stream: install probe", () => readChangeFingerprint(getDb()));
}
