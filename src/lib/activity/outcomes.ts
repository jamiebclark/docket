// The one vocabulary for activity events: kinds, outcomes, badges and presets. Pure, so the schema CHECK,
// the badges, the filters, the counts and the API enum all agree.

export const ACTIVITY_KINDS = [
  "target_published",
  "target_failed",
  "target_ambiguous",
  "target_retry_scheduled",
  "target_resolved",
  "account_needs_reauth",
  "account_connect_failed",
  "engagement_received",
  "engagement_replied",
  "engagement_ambiguous",
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export const ACTIVITY_OUTCOMES = [
  "published",
  "failed",
  "ambiguous",
  "retrying",
  "resolved",
  "needs_reauth",
  "connect_failed",
  "engagement",
] as const;
export type ActivityOutcome = (typeof ACTIVITY_OUTCOMES)[number];

export const KIND_OUTCOME: Record<ActivityKind, ActivityOutcome> = {
  target_published: "published",
  target_failed: "failed",
  target_ambiguous: "ambiguous",
  target_retry_scheduled: "retrying",
  target_resolved: "resolved",
  account_needs_reauth: "needs_reauth",
  account_connect_failed: "connect_failed",
  engagement_received: "engagement",
  engagement_replied: "published",
  engagement_ambiguous: "ambiguous",
};

export const OUTCOME_LABEL: Record<ActivityOutcome, string> = {
  published: "Published",
  failed: "Failed",
  ambiguous: "Needs your decision",
  retrying: "Retrying",
  resolved: "Resolved",
  needs_reauth: "Needs reconnecting",
  connect_failed: "Connect failed",
  engagement: "New replies",
};

/**
 * The outcome named as a heading directly above its own message.
 *
 * Identical to `OUTCOME_LABEL` but for `engagement`: 077 pinned that badge to "New replies", which is
 * one subtype standing in for the whole class, and above a message reading "1 new comment" the badge
 * contradicts itself and sends the reader looking for a reply that does not exist (020 feedback). The
 * badge is left as the spec pinned it; this is for the surfaces that print a label and its message
 * together, where the mismatch is visible.
 */
export function outcomeHeading(outcome: ActivityOutcome): string {
  return outcome === "engagement" ? "New in your Inbox" : OUTCOME_LABEL[outcome];
}

/**
 * What a *count* of these is called, for a subject line or a one-line summary: "2 failed posts",
 * "1 new inbox message".
 *
 * Separate from `OUTCOME_LABEL`, which names the state of one row and reads wrong after a number
 * ("1 Needs your decision"). Deliberately avoids the word "problem": `engagement` is an attention
 * outcome but not a `PROBLEM_OUTCOMES` member, and a subject that called a new comment a problem
 * sent people looking for a fault that was never there (020 feedback).
 */
export const OUTCOME_COUNT_NOUN: Record<ActivityOutcome, { one: string; many: string }> = {
  published: { one: "published post", many: "published posts" },
  failed: { one: "failed post", many: "failed posts" },
  ambiguous: { one: "post to decide on", many: "posts to decide on" },
  retrying: { one: "retrying post", many: "retrying posts" },
  resolved: { one: "resolved post", many: "resolved posts" },
  needs_reauth: { one: "account to reconnect", many: "accounts to reconnect" },
  connect_failed: { one: "failed connection", many: "failed connections" },
  engagement: { one: "new inbox message", many: "new inbox messages" },
};

export type ActivityTone = "success" | "danger" | "warning" | "info" | "neutral";

export const OUTCOME_TONE: Record<ActivityOutcome, ActivityTone> = {
  published: "success",
  failed: "danger",
  ambiguous: "warning",
  retrying: "info",
  resolved: "neutral",
  needs_reauth: "danger",
  connect_failed: "danger",
  engagement: "info",
};

export const SUCCESS_OUTCOMES: readonly ActivityOutcome[] = ["published"];
export const PROBLEM_OUTCOMES: readonly ActivityOutcome[] = ["failed", "ambiguous", "needs_reauth", "connect_failed"];

export const PRESETS = { successes: SUCCESS_OUTCOMES, problems: PROBLEM_OUTCOMES } as const;
export type ActivityPreset = keyof typeof PRESETS;

export function isActivityOutcome(value: unknown): value is ActivityOutcome {
  return typeof value === "string" && (ACTIVITY_OUTCOMES as readonly string[]).includes(value);
}
