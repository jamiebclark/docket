import { sql } from "drizzle-orm";
import { getDb, type Database } from "../db/client";
import { crossProject } from "./scope";

/** Opaque; compare with `===`. Never ordered, never parsed (data-model.md §2). */
export interface ChangeFingerprint {
  readonly value: string;
}

/**
 * The nine install-wide scalars in one statement, folded into one opaque string (data-model.md §2).
 * Caller wraps this in `crossProject("notifications stream: install probe", …)`.
 *
 * The first scalar reads `notification_change_marker`, a single row the activity writer bumps on an
 * attention write. It used to be `max(seq)` over `activity_events` behind a partial index spanning every
 * attention outcome — but the planner then preferred that index for the recent-problems panel too, and
 * the panel went past its 100 ms budget at twenty projects. A counter costs one primary-key read here
 * and leaves every `activity_events` read plan untouched.
 */
export async function readChangeFingerprint(db: Database): Promise<ChangeFingerprint> {
  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT
      (SELECT attention_writes::text FROM notification_change_marker)  AS attention_writes,
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
