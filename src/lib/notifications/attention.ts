// What counts as a problem worth telling someone about. Pure, so the server count and the client agree.

/** Outcomes every member of the project is told about. */
export const ATTENTION_MEMBER_OUTCOMES = ["failed", "ambiguous", "needs_reauth"] as const;

/** Counts only for the person who attempted the connection. */
export const CONNECT_FAILED = "connect_failed";

/** The unread count stops here, so the work behind it is bounded. */
export const UNREAD_CAP = 100;

export function isAttentionFor(event: { outcome: string; actorUserId: string | null }, userId: string): boolean {
  if (event.outcome === CONNECT_FAILED) return event.actorUserId !== null && event.actorUserId === userId;
  return (ATTENTION_MEMBER_OUTCOMES as readonly string[]).includes(event.outcome);
}
