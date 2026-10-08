import { z } from "zod";
import { findProvider } from "@/providers/registry";
import type { ValidationIssue } from "@/providers/types";
import { atSchema } from "@/lib/validation/scheduling";
import type { AccountRecord } from "../../dal/accounts";
import { ConflictError } from "../../dal/errors";
import { attemptActor, type ProjectScope } from "../../dal/scope";
import type { TargetRecord } from "../../dal/targets";
import { resolvedEvent } from "../activity/classify";
import { recordTargetEvent } from "../activity/record";
import { allocateNextFree, nearQueuedWarnings, plannedTime, type Warning } from "../queue";
import { syncVideoVersions } from "../video-versions";
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

/** Why a failed target's account blocks a retry, or null when it does not (D8). Shared with bulk retry. */
export function retryBlockedKey(
  account: AccountRecord | null,
  providerRegistered: boolean,
): "account_removed" | "needs_reconnecting" | "provider_unavailable" | null {
  if (!account) return "account_removed";
  if (account.status !== "active") return "needs_reconnecting";
  if (!providerRegistered) return "provider_unavailable";
  return null;
}

/** Null when a failed target may be retried; otherwise the reason, in the words the user sees (D8). */
export function retryBlockedReason(account: AccountRecord | null, providerRegistered: boolean): string | null {
  switch (retryBlockedKey(account, providerRegistered)) {
    case "account_removed":
      return "This account was removed, so the post can't be retried.";
    case "needs_reconnecting":
      return `${account!.displayName} needs to be reconnected before this post can be retried.`;
    case "provider_unavailable":
      return `The provider for ${account!.displayName} is no longer available.`;
    case null:
      return null;
  }
}

/**
 * The body of `retryTarget` for callers that already hold the post and target locks (bulk retry).
 * The caller does the permission check, the locking and `applyDerivedStatus`.
 */
export async function retryLockedTarget(
  tx: Tx,
  target: TargetRecord,
  now: Date,
  input: RetryInput,
  opts?: { via?: "bulk" },
): Promise<RetryResult> {
  if (target.status === "publishing") throw new ConflictError("Publishing in progress. Try again in a moment.", { reason: "publishing" });
  if (target.status !== "failed") throw new ConflictError("This post is no longer failed.", { reason: "not_failed" });
  const account = await tx.accounts.get(target.socialAccountId);
  const providerRegistered = !!account && !!findProvider(account.providerKey);
  const blocked = retryBlockedReason(account, providerRegistered);
  if (blocked) throw new ConflictError(blocked, { reason: retryBlockedKey(account, providerRegistered)! });
  const ev: EventCtx = { providerKey: account!.providerKey, via: opts?.via };
  if (input.mode === "requeue") return requeueTarget(tx, target, account!.displayName, now, input.expected, ev);
  if (input.mode === "at") return retryAtTime(tx, target, now, new Date(input.at), ev);
  const updated = await tx.targets.update(
    target.id,
    {
      status: "scheduled",
      nextAttemptAt: now,
      attemptCount: 0,
      stepState: null,
      firstStepAt: null,
      publishStartedAt: null,
      videoWaitSince: null,
      lastError: null,
    },
    { statuses: ["failed"] },
  );
  if (!updated) throw new ConflictError("This post is no longer failed.", { reason: "not_failed" });
  await tx.attempts.insert({ postTargetId: target.id, step: "user", outcome: "retry_requested", ...attemptActor(tx), at: now });
  await recordRetried(tx, target, now, ev, "retry_now", { mode: "now", scheduledAt: now });
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

interface EventCtx {
  providerKey: string;
  via: "bulk" | undefined;
}

/** The activity row for a retry that was applied; a bulk run reads as `bulk_retry` whichever mode it used. */
async function recordRetried(
  tx: Tx,
  target: TargetRecord,
  now: Date,
  ev: EventCtx,
  action: "retry_now" | "retry_requeue" | "retry_at",
  extra: { mode?: "now" | "requeue"; scheduledAt?: Date },
): Promise<void> {
  const { actorUserId, actorApiKeyId } = attemptActor(tx);
  await recordTargetEvent(
    tx,
    resolvedEvent({
      action: ev.via === "bulk" ? "bulk_retry" : action,
      target,
      providerKey: ev.providerKey,
      actor: { actorUserId, actorApiKeyId },
      now,
      ...(extra.scheduledAt && action !== "retry_now" ? { scheduledAt: extra.scheduledAt } : {}),
      ...(ev.via === "bulk" && extra.mode ? { mode: extra.mode } : {}),
    }),
  );
}

const lost = () => new ConflictError("This post is no longer failed.", { reason: "not_failed" });

const RESETS = { attemptCount: 0, stepState: null, firstStepAt: null, publishStartedAt: null, videoWaitSince: null, lastError: null } as const;

async function requeueTarget(
  tx: Tx,
  target: TargetRecord,
  accountName: string,
  now: Date,
  expected: string | undefined,
  ev: EventCtx,
): Promise<RetryResult> {
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
      ...attemptActor(tx),
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
    ...attemptActor(tx),
    at: now,
  });
  await recordRetried(tx, target, now, ev, "retry_requeue", { mode: "requeue", scheduledAt: slot.instant });
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

async function retryAtTime(tx: Tx, target: TargetRecord, now: Date, when: Date, ev: EventCtx): Promise<RetryResult> {
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
    ...attemptActor(tx),
    at: now,
  });
  await recordRetried(tx, target, now, ev, "retry_at", { scheduledAt: when });
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

export async function retryTarget(
  scope: ProjectScope,
  targetId: string,
  input?: unknown,
  opts?: { postId?: string },
): Promise<RetryResult> {
  const id = uuid.parse(targetId);
  const parsed = retryInputSchema.parse(input ?? { mode: "now" });
  let postId: string | null = null;
  const result = await withLockedTarget(
    scope,
    id,
    { post: ["schedule"] },
    (tx, post, target, now) => {
      postId = post.id;
      return retryLockedTarget(tx, target, now, parsed);
    },
    opts,
  );
  // A failed or vanished adapted video is queued again (FR-025).
  if (postId) await syncVideoVersions(scope, postId, { requeueFailed: true, targetIds: [id] });
  return result;
}
