// failures: the read side of "posts that did not go out" (contracts/services.md §1).
import { z } from "zod";
import { findProvider } from "@/providers/registry";
import * as clock from "../dal/clock";
import { ForbiddenError, NotFoundError } from "../dal/errors";
import type { AccountRecord } from "../dal/accounts";
import type { AttemptRow } from "../dal/attempts";
import type { ProjectScope } from "../dal/scope";
import type { TargetRecord } from "../dal/targets";
import { gate, retryBlockedReason } from "./posts";
import { excerptOf } from "./posts/list";
import { peekNextFree, plannedTime } from "./queue";

export const FAILURES_PAGE_SIZE = 25;

export const failuresQuerySchema = z.object({
  status: z.enum(["all", "ambiguous", "failed"]).catch("all").default("all"),
  account: z.uuid().optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(100_000).catch(1).default(1),
});

export interface FailureActions {
  canMarkPublished: boolean;
  canRequeue: boolean;
  canMarkNotPublished: boolean;
  canRetry: boolean;
  retryBlockedReason: string | null;
}

export interface AttemptEntryView {
  id: string;
  at: Date;
  step: string;
  outcome: string;
  /** Already redacted when written. */
  request: Record<string, unknown>;
  response: Record<string, unknown>;
  error: string | null;
  actor: { kind: "member"; name: string } | { kind: "system" };
}

export interface AttemptRun {
  step: string;
  outcome: string;
  error: string | null;
  count: number;
  entries: AttemptEntryView[];
}

export interface FailureRow {
  targetId: string;
  postId: string;
  status: "ambiguous" | "failed";
  account: { id: string; name: string; providerName: string; status: "active" | "needs_reauth" | "removed" };
  excerpt: string;
  intendedAt: Date | null;
  intendedLocal: string | null;
  scheduleKind: "slot" | "explicit" | "now" | null;
  lastError: string | null;
  attemptCount: number;
  enteredAt: Date;
  actions: FailureActions;
  attempts: AttemptRun[];
}

export interface FailureList {
  rows: FailureRow[];
  totals: { ambiguous: number; failed: number };
  filtered: number;
  page: number;
  pageSize: number;
  accounts: { id: string; name: string }[];
}

export type RequeuePreview =
  | { ok: true; scheduledAt: string; localTime: string; slotId: string }
  | { ok: false; code: "no_active_slots" | "no_free_occurrence" | "account_unavailable" | "validation"; message: string };

/** Consecutive entries with the same step, outcome and error form one run; nothing is dropped (FR-003). */
export function groupAttemptRuns(entries: readonly AttemptEntryView[]): AttemptRun[] {
  const runs: AttemptRun[] = [];
  for (const entry of entries) {
    const last = runs[runs.length - 1];
    if (last && last.step === entry.step && last.outcome === entry.outcome && last.error === entry.error) {
      last.entries.push(entry);
      last.count = last.entries.length;
    } else {
      runs.push({ step: entry.step, outcome: entry.outcome, error: entry.error, count: 1, entries: [entry] });
    }
  }
  return runs;
}

/** Turns stored attempts into views, resolving actor ids with one batched name lookup. */
export async function toAttemptViews(scope: ProjectScope, rows: readonly AttemptRow[]): Promise<AttemptEntryView[]> {
  const needsNames = rows.some((r) => r.actorUserId);
  const names = new Map<string, string>();
  if (needsNames) for (const m of await scope.members.list()) names.set(m.userId, m.name);
  return rows.map((a) => ({
    id: a.id,
    at: a.createdAt,
    step: a.step,
    outcome: a.outcome,
    request: (a.requestSummary ?? {}) as Record<string, unknown>,
    response: (a.responseSummary ?? {}) as Record<string, unknown>,
    error: a.error,
    actor: a.actorUserId ? { kind: "member", name: names.get(a.actorUserId) ?? "Former member" } : { kind: "system" },
  }));
}

/** What the viewer may do with a target, from their rights, its status and its account (D8). */
export function targetActions(canSchedule: boolean, status: string, account: AccountRecord | null): FailureActions {
  const registered = !!account && !!findProvider(account.providerKey);
  const blocked = status === "failed" ? retryBlockedReason(account, registered) : null;
  return {
    canMarkPublished: canSchedule && status === "ambiguous",
    canRequeue: canSchedule && status === "ambiguous" && !!account && account.status === "active" && registered,
    canMarkNotPublished: canSchedule && status === "ambiguous",
    canRetry: canSchedule && status === "failed" && blocked === null,
    retryBlockedReason: blocked,
  };
}

function need(scope: ProjectScope, request: Parameters<ProjectScope["can"]>[0]): void {
  if (!scope.can(request)) throw new ForbiddenError();
}

/** FR-001–FR-004, FR-006. */
export async function listFailures(scope: ProjectScope, input?: unknown): Promise<FailureList> {
  need(scope, { post: ["view"] });
  const query = failuresQuerySchema.parse(input ?? {});
  const statuses = query.status === "all" ? (["ambiguous", "failed"] as const) : ([query.status] as const);
  const [found, totals, accounts] = await Promise.all([
    scope.targets.listAttention({
      statuses,
      accountId: query.account,
      limit: FAILURES_PAGE_SIZE,
      offset: (query.page - 1) * FAILURES_PAGE_SIZE,
    }),
    scope.targets.countAttention(),
    scope.accounts.list(),
  ]);
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const stored = await scope.attempts.listForTargets(found.rows.map((r) => r.id));
  const views = await toAttemptViews(scope, stored);
  const attemptsOf = new Map<string, AttemptEntryView[]>();
  stored.forEach((a, i) => {
    const list = attemptsOf.get(a.postTargetId) ?? [];
    list.push(views[i]!);
    attemptsOf.set(a.postTargetId, list);
  });
  const canSchedule = scope.can({ post: ["schedule"] });
  const rows = found.rows.map((t: TargetRecord & { baseText: string }): FailureRow => {
    const account = byId.get(t.socialAccountId) ?? null;
    return {
      targetId: t.id,
      postId: t.postId,
      status: t.status as "ambiguous" | "failed",
      account: {
        id: t.socialAccountId,
        name: account?.displayName ?? "Removed account",
        providerName: account ? (findProvider(account.providerKey)?.displayName ?? account.providerKey) : "",
        status: account ? account.status : "removed",
      },
      excerpt: excerptOf(t.overrideText ?? t.baseText),
      intendedAt: t.scheduledAt,
      intendedLocal: t.scheduledAt ? plannedTime(t.scheduledAt, t.slotId, scope.project.timezone).localTime : null,
      scheduleKind: t.scheduleKind,
      lastError: t.lastError,
      attemptCount: t.attemptCount,
      enteredAt: t.updatedAt,
      actions: targetActions(canSchedule, t.status, account),
      attempts: groupAttemptRuns(attemptsOf.get(t.id) ?? []),
    };
  });
  return {
    rows,
    totals,
    filtered: found.total,
    page: query.page,
    pageSize: FAILURES_PAGE_SIZE,
    accounts: accounts.map((a) => ({ id: a.id, name: a.displayName })),
  };
}

/** FR-005: ambiguous targets only; 0 when the viewer cannot see posts. */
export async function countNeedsDecision(scope: ProjectScope): Promise<number> {
  if (!scope.can({ post: ["view"] })) return 0;
  return (await scope.targets.countAttention()).ambiguous;
}

/** FR-008 dialog preview. No writes. */
export async function previewRequeue(scope: ProjectScope, targetId: string): Promise<RequeuePreview> {
  need(scope, { post: ["schedule"] });
  const target = await scope.targets.get(z.uuid().parse(targetId));
  if (!target) throw new NotFoundError();
  const g = await gate(scope, target);
  if (!g.ok) return { ok: false, code: g.code === "validation" ? "validation" : "account_unavailable", message: g.message };
  const peek = await peekNextFree(scope, target.socialAccountId, { after: await clock.now() });
  if (!peek.ok) return { ok: false, code: peek.code, message: peek.message };
  return { ok: true, scheduledAt: peek.planned.scheduledAt, localTime: peek.planned.localTime, slotId: peek.slotId };
}
