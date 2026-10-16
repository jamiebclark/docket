// What counts as a problem worth telling someone about. Pure, so the server count and the client agree.

/** Outcomes every member of the project is told about. */
export const ATTENTION_MEMBER_OUTCOMES = ["failed", "ambiguous", "needs_reauth", "engagement"] as const;

/** Counts only for the person who attempted the connection. */
export const CONNECT_FAILED = "connect_failed";

/** The unread count stops here, so the work behind it is bounded. */
export const UNREAD_CAP = 100;

/** A person may hold at most this many sparse marks per project — twice UNREAD_CAP (N16.3). */
export const EVENT_MARK_CAP = UNREAD_CAP * 2;

export function isAttentionFor(event: { outcome: string; actorUserId: string | null }, userId: string): boolean {
  if (event.outcome === CONNECT_FAILED) return event.actorUserId !== null && event.actorUserId === userId;
  return (ATTENTION_MEMBER_OUTCOMES as readonly string[]).includes(event.outcome);
}

/** Every outcome that can put something in front of somebody: the member set plus a connect attempt. */
export const ATTENTION_OUTCOMES = [...ATTENTION_MEMBER_OUTCOMES, CONNECT_FAILED] as const;

/**
 * Whether an outcome is one anybody could need to see. Unlike `isAttentionFor`, this asks nothing about
 * who: it is the writer-side test for whether a write can change *someone's* count (045).
 */
export function isAttentionOutcome(outcome: string): boolean {
  return (ATTENTION_OUTCOMES as readonly string[]).includes(outcome);
}
