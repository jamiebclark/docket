import type { PostType } from "@/providers/types";
import type { CompositionCheck, TargetCheck } from "@/server/services/posts";

export type Severity = "error" | "warning" | "info";
export const SEVERITIES: readonly Severity[] = ["error", "warning", "info"];
export const SEVERITY_LABEL: Record<Severity, string> = { error: "Errors", warning: "Warnings", info: "Notes" };

/** Wire shape of `CompositionCheck` (the route returns JSON). */
export type CheckResult = CompositionCheck;

export interface CheckInput {
  postId?: string;
  baseText: string;
  mediaIds: string[];
  targets: { accountId: string; overrideText?: string | null; postType?: PostType | null }[];
}

export const counterText = (t: Pick<TargetCheck, "count" | "limit">): string =>
  t.limit === null ? `${t.count}` : `${t.count} / ${t.limit}`;

export const isOverLimit = (t: Pick<TargetCheck, "count" | "limit">): boolean => t.limit !== null && t.count > t.limit;

export function groupIssues(issues: TargetCheck["issues"]): { severity: Severity; items: TargetCheck["issues"] }[] {
  return SEVERITIES.map((severity) => ({ severity, items: issues.filter((i) => i.severity === severity) })).filter(
    (g) => g.items.length > 0,
  );
}

/** Calls the compose-check route. A failed or non-OK response is `null`: the composer keeps its last result. */
export async function fetchCheck(
  slug: string,
  input: CheckInput,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<CheckResult | null> {
  try {
    const res = await fetchImpl(`/p/${encodeURIComponent(slug)}/compose/check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { ok: boolean; data?: CheckResult };
    return json.ok && json.data ? json.data : null;
  } catch {
    return null;
  }
}

/** Why scheduling is unavailable, or `null` when it is allowed. The reason is shown next to the disabled button. */
export function scheduleBlockedReason(args: {
  selected: number;
  check: CheckResult | null;
  editable: boolean;
  reviewBlocked: boolean;
}): string | null {
  if (!args.editable) return "Publishing has started, so this post can no longer be changed.";
  if (args.reviewBlocked) return "This post is waiting for review before it can be scheduled.";
  if (args.selected === 0) return "Choose at least one account.";
  if (!args.check) return "Checking…";
  if (!args.check.targets.some((t) => t.canSchedule)) return "Fix the errors above for at least one account.";
  return null;
}

export type EmptyAccountsAudience = "manage" | "ask";

/** Who sees which empty state when the project has no accounts (US1-AS8). */
export const emptyAccountsAudience = (canManageAccounts: boolean): EmptyAccountsAudience =>
  canManageAccounts ? "manage" : "ask";
