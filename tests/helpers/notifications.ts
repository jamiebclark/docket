import { randomUUID } from "node:crypto";
import { createActivityRepo, type NewActivityEvent } from "../../src/server/dal/activity";
import { createNotificationsRepo } from "../../src/server/dal/notifications";
import type { ActivityKind } from "../../src/lib/activity/outcomes";
import { testDb } from "./db";

const DETAILS: Record<ActivityKind, NewActivityEvent["details"]> = {
  target_published: {},
  target_failed: { attempt: 1 },
  target_ambiguous: {},
  target_retry_scheduled: { attempt: 1, nextAttemptAt: "2030-05-01T12:00:00.000Z" },
  target_resolved: { action: "marked_published" },
  account_needs_reauth: { reason: "renewal_refused" },
  account_connect_failed: { via: "oauth", code: "platform_error" },
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

/** Starts a person's reading position at the project's newest event (what joining does). */
export function startReading(projectId: string, userId: string) {
  return createNotificationsRepo(testDb(), projectId, userId).createAtCurrentPosition();
}

export const ALL_KINDS = Object.keys(DETAILS) as ActivityKind[];
