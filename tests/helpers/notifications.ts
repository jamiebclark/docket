import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createActivityRepo, type NewActivityEvent } from "../../src/server/dal/activity";
import { createNotificationsRepo } from "../../src/server/dal/notifications";
import type { ActivityKind } from "../../src/lib/activity/outcomes";
import { EVENT_MARK_CAP } from "../../src/lib/notifications/attention";
import { ATTENTION_KINDS, type SwitchAxis } from "../../src/lib/notifications/eligibility";
import { runCrossProject } from "../../src/server/db/cross-project";
import { testDb } from "./db";

const DETAILS: Record<ActivityKind, NewActivityEvent["details"]> = {
  target_published: {},
  target_failed: { attempt: 1 },
  target_ambiguous: {},
  target_retry_scheduled: { attempt: 1, nextAttemptAt: "2030-05-01T12:00:00.000Z" },
  target_resolved: { action: "marked_published" },
  account_needs_reauth: { reason: "renewal_refused" },
  account_connect_failed: { via: "oauth", code: "platform_error" },
  engagement_received: { items: 1 },
  engagement_replied: { itemKind: "reply" },
  engagement_ambiguous: { reason: "timeout" },
};

/** One activity event of `kind` in a project, with valid per-kind details. */
export function recordEvent(projectId: string, kind: ActivityKind, extra: Partial<NewActivityEvent> = {}) {
  return createActivityRepo(testDb(), projectId).insert({
    kind,
    occurredAt: new Date(),
    postId: kind.startsWith("target_") ? randomUUID() : null,
    postTargetId: kind.startsWith("target_") ? randomUUID() : null,
    socialAccountId: randomUUID(),
    providerKey: "bluesky",
    message: `${kind}.`,
    details: DETAILS[kind],
    ...extra,
  } as NewActivityEvent);
}

/** `recordEvent`, but tagged with the given provider keys — a single platform, or several for a shared failure. */
export function recordEventOnPlatforms(projectId: string, kind: ActivityKind, platforms: readonly string[], extra: Partial<NewActivityEvent> = {}) {
  return recordEvent(projectId, kind, { providerKey: platforms.length === 1 ? platforms[0]! : null, providerKeys: platforms, ...extra });
}

/** Starts a person's reading position at the project's newest event (what joining does). */
export function startReading(projectId: string, userId: string) {
  return createNotificationsRepo(testDb(), projectId, userId).createAtCurrentPosition();
}

/** Turns one of a person's switches on or off for a project — the write path tests exercise directly. */
export function setSwitch(projectId: string, userId: string, axis: SwitchAxis, key: string, on: boolean) {
  return createNotificationsRepo(testDb(), projectId, userId).setSwitches({ switches: [{ axis, key }], on });
}

/** The old mute's equivalent under the new model: all four kind switches off for this project. */
export function muteProject(projectId: string, userId: string) {
  return createNotificationsRepo(testDb(), projectId, userId).setSwitches({
    switches: ATTENTION_KINDS.map((key) => ({ axis: "kind" as const, key })),
    on: false,
  });
}

export const ALL_KINDS = Object.keys(DETAILS) as ActivityKind[];

/**
 * Seeds one mark directly, bypassing the row-action transaction (no product path exists yet for an
 * already-expired instant, since a live write would refuse to resolve a snooze that isn't in the future).
 * No `until` is "read for ever"; a `Date` is a snooze until that instant, past or future.
 */
export async function markEventFor(projectId: string, userId: string, eventId: string, until?: Date): Promise<void> {
  const db = testDb();
  await runCrossProject("test: seed a notification mark", async () => {
    const event = await db.execute(sql`SELECT seq::text AS seq FROM activity_events WHERE project_id = ${projectId} AND id = ${eventId}`);
    const seq = (event.rows[0] as { seq: string } | undefined)?.seq;
    if (seq === undefined) throw new Error(`markEventFor: no event ${eventId} in project ${projectId}`);
    const countsAgainAt = until ? sql`${until.toISOString()}::timestamptz` : sql`'infinity'::timestamptz`;
    await db.execute(sql`
      INSERT INTO notification_event_marks (project_id, user_id, event_id, event_seq, counts_again_at)
      VALUES (${projectId}, ${userId}, ${eventId}, ${seq}::bigint, ${countsAgainAt})
      ON CONFLICT (project_id, user_id, event_id)
      DO UPDATE SET counts_again_at = excluded.counts_again_at, updated_at = now()`);
  });
}

/** Creates `EVENT_MARK_CAP` fresh attention events and marks every one read, filling the person's cap for this project. */
export async function fillMarksToCap(projectId: string, userId: string): Promise<string[]> {
  const eventIds: string[] = [];
  for (let i = 0; i < EVENT_MARK_CAP; i++) {
    const event = await recordEvent(projectId, "account_needs_reauth");
    await markEventFor(projectId, userId, event.id);
    eventIds.push(event.id);
  }
  return eventIds;
}

/** The person's stored switches for this project, as written — for assertions, not for product code. */
export async function preferenceRows(
  projectId: string,
  userId: string,
): Promise<{ axis: string; switchKey: string; onFromSeq: string | null }[]> {
  const db = testDb();
  return runCrossProject("test: read notification preferences", async () => {
    const result = await db.execute(sql`
      SELECT axis, switch_key, on_from_seq::text AS on_from_seq
      FROM notification_preferences
      WHERE project_id = ${projectId} AND user_id = ${userId}
      ORDER BY axis, switch_key`);
    return result.rows.map((r) => {
      const row = r as { axis: string; switch_key: string; on_from_seq: string | null };
      return { axis: row.axis, switchKey: row.switch_key, onFromSeq: row.on_from_seq };
    });
  });
}

/** The person's marks for this project, as seeded or written — for assertions, not for product code. */
export async function marksFor(
  projectId: string,
  userId: string,
): Promise<{ eventId: string; eventSeq: string; countsAgainAt: "infinity" | string }[]> {
  const db = testDb();
  return runCrossProject("test: read notification marks", async () => {
    const result = await db.execute(sql`
      SELECT event_id, event_seq::text AS event_seq,
        CASE WHEN counts_again_at = 'infinity'::timestamptz THEN 'infinity'
             ELSE to_char(counts_again_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS counts_again_at
      FROM notification_event_marks
      WHERE project_id = ${projectId} AND user_id = ${userId}
      ORDER BY event_seq`);
    return result.rows.map((r) => {
      const row = r as { event_id: string; event_seq: string; counts_again_at: string };
      return { eventId: row.event_id, eventSeq: row.event_seq, countsAgainAt: row.counts_again_at };
    });
  });
}
