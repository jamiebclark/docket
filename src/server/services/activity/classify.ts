import type { ActivityDetails, ConnectFailCode, ResolveAction } from "../../../lib/activity/details";
import { resolvedMessage } from "../../../lib/activity/text";
import type { NewActivityEvent } from "../../dal/activity";
import type { AttemptOutcome } from "../../dal/attempts";
import type { TargetPatch } from "../../dal/targets";
import { redact } from "../../scheduler/redact";

// Pure rules: which transitions are worth an activity row, and what it says (research P3). `null` means "no event".

export interface ActorRefs {
  actorUserId?: string | null;
  actorApiKeyId?: string | null;
}

interface TargetRef {
  id: string;
  postId: string;
  socialAccountId: string;
}

interface AccountRef {
  id: string;
  providerKey: string;
}

/** A link is kept only when it leaves room under the 2,000-byte details CHECK; the post keeps its own URL (F5). */
const MAX_DETAIL_URL_BYTES = 1900;
const fitUrl = (url: string | null | undefined): string | null =>
  url && Buffer.byteLength(url) <= MAX_DETAIL_URL_BYTES ? url : null;

function targetEvent(
  target: TargetRef,
  providerKey: string,
  base: Pick<NewActivityEvent, "kind" | "message" | "details" | "occurredAt"> & ActorRefs,
): NewActivityEvent {
  return {
    ...base,
    postId: target.postId,
    postTargetId: target.id,
    socialAccountId: target.socialAccountId,
    providerKey,
  } as NewActivityEvent;
}

/** What a provider step result did to its target, as seen in the applied patch. */
export function eventForStep(input: {
  outcome: { outcome: AttemptOutcome; error: string | null; patch: TargetPatch };
  now: Date;
  target: TargetRef;
  account: AccountRef;
}): NewActivityEvent | null {
  const { outcome, now, target, account } = input;
  const { patch } = outcome;
  const error = outcome.error ?? "";
  const make = (kind: NewActivityEvent["kind"], message: string, details: ActivityDetails) =>
    targetEvent(target, account.providerKey, { kind, message, details, occurredAt: now });
  switch (outcome.outcome) {
    case "done":
      return make("target_published", "Published.", patch.externalUrl && !fitUrl(patch.externalUrl) ? {} : { url: patch.externalUrl ?? null });
    case "fatal_error":
      return make("target_failed", error || "Failed.", {});
    case "ambiguous":
      return make("target_ambiguous", error || "May have published.", {});
    case "retryable_error": {
      const attempt = patch.attemptCount ?? 1;
      if (patch.status === "failed") {
        return make("target_failed", `Gave up after ${attempt} attempts: ${error}`, { attempt, gaveUp: true });
      }
      const next = patch.nextAttemptAt ?? now;
      return make("target_retry_scheduled", error || "Retrying.", { attempt, nextAttemptAt: next.toISOString() });
    }
    default:
      // `continue` and every engine or user attempt outcome: not a result worth a row.
      return null;
  }
}

/** The settle / interruption decisions made while claiming a due target. */
export function eventForDecision(input: {
  decision: { patch: TargetPatch; attempts?: { outcome: AttemptOutcome; error?: string | null }[] | undefined };
  target: TargetRef;
  account: AccountRef;
  now: Date;
}): NewActivityEvent | null {
  const { decision, target, account, now } = input;
  const { patch } = decision;
  const attempts = decision.attempts ?? [];
  const last = attempts[attempts.length - 1];
  const make = (kind: NewActivityEvent["kind"], message: string, details: ActivityDetails) =>
    targetEvent(target, account.providerKey, { kind, message, details, occurredAt: now });

  if (patch.status === "failed") {
    const engine = engineReason(last);
    if (!engine) return null;
    const attempt = engine === "interrupted" ? patch.attemptCount : undefined;
    return make("target_failed", patch.lastError ?? "Failed.", { engine, ...(attempt ? { attempt } : {}) });
  }
  if (patch.status === "ambiguous") {
    return make("target_ambiguous", patch.lastError ?? "May have published.", { engine: "recovered_ambiguous" });
  }
  if (attempts.some((a) => a.outcome === "recovered_retry") && patch.attemptCount) {
    return make("target_retry_scheduled", "Publishing was interrupted; retrying.", {
      attempt: patch.attemptCount,
      nextAttemptAt: (patch.nextAttemptAt ?? now).toISOString(),
      interrupted: true,
    });
  }
  // Deferral only, or lease only.
  return null;
}

function engineReason(
  last: { outcome: AttemptOutcome; error?: string | null } | undefined,
): "account_unavailable" | "did_not_complete" | "invalid_settings" | "post_gone" | "interrupted" | null {
  switch (last?.outcome) {
    case "account_unavailable":
      return last.error === "Invalid account settings." ? "invalid_settings" : "account_unavailable";
    case "did_not_complete":
      return "did_not_complete";
    case "fatal_error":
      return "post_gone";
    case "recovered_retry":
      return "interrupted";
    default:
      return null;
  }
}

/** A person (or a bulk retry) acting on a failed or ambiguous target. */
export function resolvedEvent(input: {
  action: ResolveAction;
  target: TargetRef;
  providerKey: string;
  actor: ActorRefs;
  now: Date;
  url?: string | null | undefined;
  scheduledAt?: Date | null | undefined;
  mode?: "now" | "requeue" | undefined;
  requeue?: "no_free_slot" | undefined;
}): NewActivityEvent {
  const { action, mode, requeue } = input;
  const details: ActivityDetails = {
    action,
    ...(fitUrl(input.url) ? { url: input.url } : {}),
    ...(input.scheduledAt ? { scheduledAt: input.scheduledAt.toISOString() } : {}),
    ...(mode ? { mode } : {}),
    ...(requeue ? { requeue } : {}),
  };
  return targetEvent(input.target, input.providerKey, {
    kind: "target_resolved",
    message: resolvedMessage({ action, mode, requeue }),
    details,
    occurredAt: input.now,
    actorUserId: input.actor.actorUserId ?? null,
    actorApiKeyId: input.actor.actorApiKeyId ?? null,
  });
}

/** An account that was active and now needs its owner to reconnect it. */
export function needsReauthEvent(input: {
  account: AccountRef;
  reason: "renewal_refused" | "credentials_invalid";
  message: string | null;
  now: Date;
}): NewActivityEvent {
  return {
    kind: "account_needs_reauth",
    occurredAt: input.now,
    socialAccountId: input.account.id,
    providerKey: input.account.providerKey,
    message: input.message?.trim() || "This account needs reconnecting.",
    details: { reason: input.reason },
  };
}

/** A connect attempt that failed, with exactly the text the person was shown, minus anything secret. */
export function connectFailedEvent(input: {
  via: "oauth" | "paste" | "credentials";
  code: ConnectFailCode;
  message: string;
  providerKeys: readonly string[];
  providerKey?: string | null;
  groupKey?: string | null;
  accountId?: string | null;
  actor: ActorRefs;
  now: Date;
  secrets?: readonly string[];
}): NewActivityEvent {
  const providerKey = input.providerKey ?? null;
  return {
    kind: "account_connect_failed",
    occurredAt: input.now,
    socialAccountId: input.accountId ?? null,
    providerKey,
    providerKeys: providerKey ? [providerKey] : [...input.providerKeys],
    groupKey: input.groupKey ?? null,
    actorUserId: input.actor.actorUserId ?? null,
    actorApiKeyId: input.actor.actorApiKeyId ?? null,
    message: redact(input.message, input.secrets ?? []),
    details: { via: input.via, code: input.code },
  };
}
