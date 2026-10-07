import { z } from "zod";
import { findProvider } from "@/providers/registry";
import type { ValidationIssue } from "@/providers/types";
import { atSchema } from "@/lib/validation/scheduling";
import type { AccountRecord } from "../../dal/accounts";
import { ConflictError } from "../../dal/errors";
import type { ProjectScope } from "../../dal/scope";
import type { TargetRecord } from "../../dal/targets";
import { allocateNextFree, nearQueuedWarnings, plannedTime, type Warning } from "../queue";
import { gate } from "./gate";
import { withLockedTarget } from "./locked";
import { explicitSchedulePatch } from "./schedule-patch";

type Tx = ProjectScope;
const uuid = z.uuid();

export const retryInputSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("now") }),
  z.object({ mode: z.literal("requeue"), expected: z.iso.datetime({ offset: true }).optional() }),
  z.object({ mode: z.literal("at"), at: atSchema }),
]);

export type RetryInput =
  | { mode: "now" }
  | { mode: "requeue"; expected?: string }
  | { mode: "at"; at: string };

export type RetryFailureReason = "no_active_slots" | "no_free_occurrence" | "in_past" | "validation" | "account_unavailable";

export type RetryResult =
  | {
      status: "scheduled";
      mode: RetryInput["mode"];
      scheduledAt: string;
      localTime: string;
      slotId: string | null;
      changedFromPreview: boolean;
      warnings: Warning[];
    }
  | { status: "failed"; reason: RetryFailureReason; message: string; issues?: ValidationIssue[] };

/** Null when a failed target may be retried; otherwise the reason, in the words the user sees (D8). */
export function retryBlockedReason(account: AccountRecord | null, providerRegistered: boolean): string | null {
  if (!account) return "This account was removed, so the post can't be retried.";
  if (account.status !== "active") return `${account.displayName} needs to be reconnected before this post can be retried.`;
  if (!providerRegistered) return `The provider for ${account.displayName} is no longer available.`;
  return null;
}

/**
 * The body of `retryTarget` for callers that already hold the post and target locks (bulk retry).
 * The caller does the permission check, the locking and `applyDerivedStatus`.
 */
export async function retryLockedTarget(tx: Tx, target: TargetRecord, now: Date, input: RetryInput): Promise<RetryResult> {
  if (target.status === "publishing") throw new ConflictError("Publishing in progress. Try again in a moment.");
  if (target.status !== "failed") throw new ConflictError("This post is no longer failed.");
  const account = await tx.accounts.get(target.socialAccountId);
  const blocked = retryBlockedReason(account, !!account && !!findProvider(account.providerKey));
  if (blocked) throw new ConflictError(blocked);
  if (input.mode === "requeue") return requeueTarget(tx, target, account!.displayName, now, input.expected);
  if (input.mode === "at") return retryAtTime(tx, target, now, new Date(input.at));
  const updated = await tx.targets.update(
    target.id,
    {
      status: "scheduled",
      nextAttemptAt: now,
      attemptCount: 0,
      stepState: null,
      firstStepAt: null,
      publishStartedAt: null,
      lastError: null,
    },
    { statuses: ["failed"] },
  );
  if (!updated) throw new ConflictError("This post is no longer failed.");
  await tx.attempts.insert({ postTargetId: target.id, step: "user", outcome: "retry_requested", actorUserId: tx.membership.userId, at: now });
  return {
    status: "scheduled",
    mode: "now",
    scheduledAt: now.toISOString(),
    localTime: plannedLocal(tx, now),
    slotId: null,
    changedFromPreview: false,
    warnings: [],
  };
}

const lost = () => new ConflictError("This post is no longer failed.");

const RESETS = { attemptCount: 0, stepState: null, firstStepAt: null, publishStartedAt: null, lastError: null } as const;

async function requeueTarget(tx: Tx, target: TargetRecord, accountName: string, now: Date, expected?: string): Promise<RetryResult> {
  const g = await gate(tx, target);
  if (!g.ok) return { status: "failed", reason: g.code === "validation" ? "validation" : "account_unavailable", message: g.message, issues: g.issues };
  const slot = await allocateNextFree(tx, { id: target.id, accountId: target.socialAccountId }, { after: now, ownOccurrence: target.slotOccurrenceAt });
  if (!slot.ok) {
    const reason = slot.code === "no_active_slots" ? "no_active_slots" : "no_free_occurrence";
    const message =
      reason === "no_active_slots"
        ? `Not retried — ${accountName} has no active posting slots. Retry now or pick a time.`
        : `Not retried — ${accountName} has no free posting slot. Retry now or pick a time.`;
    if (!(await tx.targets.update(target.id, { lastError: message }, { statuses: ["failed"] }))) throw lost();
    await tx.attempts.insert({
      postTargetId: target.id,
      step: "user",
      outcome: "retry_requested",
      requestSummary: { mode: "requeue", reason },
      error: "no_free_slot",
      actorUserId: tx.membership.userId,
      at: now,
    });
    return { status: "failed", reason, message };
  }
  // Throwing here rolls back the occurrence hold taken by the allocator.
  if (!(await tx.targets.update(target.id, { status: "scheduled", ...RESETS }, { statuses: ["failed"] }))) throw lost();
  const scheduledAt = slot.instant.toISOString();
  await tx.attempts.insert({
    postTargetId: target.id,
    step: "user",
    outcome: "retry_requested",
    requestSummary: { mode: "requeue", scheduledAt, slotId: slot.slotId, ...(expected !== undefined ? { expected } : {}) },
    actorUserId: tx.membership.userId,
    at: now,
  });
  return {
    status: "scheduled",
    mode: "requeue",
    scheduledAt,
    localTime: slot.planned.localTime,
    slotId: slot.slotId,
    changedFromPreview: expected !== undefined && +new Date(expected) !== +slot.instant,
    warnings: [],
  };
}

async function retryAtTime(tx: Tx, target: TargetRecord, now: Date, when: Date): Promise<RetryResult> {
  if (when.getTime() <= now.getTime()) {
    return { status: "failed", reason: "in_past", message: "That time has passed. Use Retry now instead." };
  }
  const g = await gate(tx, target);
  if (!g.ok) return { status: "failed", reason: g.code === "validation" ? "validation" : "account_unavailable", message: g.message, issues: g.issues };
  if (!(await tx.targets.update(target.id, { ...explicitSchedulePatch("explicit", when), status: "scheduled", ...RESETS }, { statuses: ["failed"] }))) throw lost();
  const scheduledAt = when.toISOString();
  await tx.attempts.insert({
    postTargetId: target.id,
    step: "user",
    outcome: "retry_requested",
    requestSummary: { mode: "at", scheduledAt },
    actorUserId: tx.membership.userId,
    at: now,
  });
  return {
    status: "scheduled",
    mode: "at",
    scheduledAt,
    localTime: plannedLocal(tx, when),
    slotId: null,
    changedFromPreview: false,
    warnings: await nearQueuedWarnings(tx, target.socialAccountId, when, target.id),
  };
}

function plannedLocal(tx: Tx, when: Date): string {
  return plannedTime(when, null, tx.project.timezone).localTime;
}

export async function retryTarget(scope: ProjectScope, targetId: string, input?: unknown): Promise<RetryResult> {
  const id = uuid.parse(targetId);
  const parsed = retryInputSchema.parse(input ?? { mode: "now" });
  return withLockedTarget(scope, id, { post: ["schedule"] }, (tx, _post, target, now) => retryLockedTarget(tx, target, now, parsed));
}
