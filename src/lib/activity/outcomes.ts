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
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export const ACTIVITY_OUTCOMES = ["published", "failed", "ambiguous", "retrying", "resolved", "needs_reauth", "connect_failed"] as const;
export type ActivityOutcome = (typeof ACTIVITY_OUTCOMES)[number];

export const KIND_OUTCOME: Record<ActivityKind, ActivityOutcome> = {
  target_published: "published",
  target_failed: "failed",
  target_ambiguous: "ambiguous",
  target_retry_scheduled: "retrying",
  target_resolved: "resolved",
  account_needs_reauth: "needs_reauth",
  account_connect_failed: "connect_failed",
};

export const OUTCOME_LABEL: Record<ActivityOutcome, string> = {
  published: "Published",
  failed: "Failed",
  ambiguous: "Needs your decision",
  retrying: "Retrying",
  resolved: "Resolved",
  needs_reauth: "Needs reconnecting",
  connect_failed: "Connect failed",
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
};

export const SUCCESS_OUTCOMES: readonly ActivityOutcome[] = ["published"];
export const PROBLEM_OUTCOMES: readonly ActivityOutcome[] = ["failed", "ambiguous", "needs_reauth", "connect_failed"];

export const PRESETS = { successes: SUCCESS_OUTCOMES, problems: PROBLEM_OUTCOMES } as const;
export type ActivityPreset = keyof typeof PRESETS;

export function isActivityOutcome(value: unknown): value is ActivityOutcome {
  return typeof value === "string" && (ACTIVITY_OUTCOMES as readonly string[]).includes(value);
}
