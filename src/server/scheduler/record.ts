import type { StepResult } from "../../providers/types";
import type { AttemptOutcome } from "../dal/attempts";
import { forSchedulerProject } from "../dal/scheduler";
import type { TargetPatch } from "../dal/targets";
import { eventForStep } from "../services/activity/classify";
import { applyDerivedStatus } from "../services/posts/status";
import { nextRetryAt } from "./backoff";
import type { SchedulerConfig } from "./config";
import { redact } from "./redact";

export interface StepOutcome {
  patch: TargetPatch;
  outcome: AttemptOutcome;
  error: string | null;
}

export const AFTER_PUBLISH_SUFFIX = "The post may already be live; check before retrying.";

const RELEASED = { leaseOwner: null, leaseUntil: null, inFlightStep: null, inFlightMayPublish: null } as const;

/**
 * Pure: what a provider's step result does to its target (contracts/providers.md, research D9).
 * `target.stepState` is non-null once a step has completed, which keeps a retried target `publishing`.
 */
export function applyStepResult(input: {
  result: StepResult;
  target: { attemptCount: number; stepState: unknown | null };
  now: Date;
  config: Pick<SchedulerConfig, "maxAttempts" | "backoffBaseMs" | "backoffMaxMs">;
  secrets?: readonly string[];
  /** The leased step runs after the publishing step was sent: running out of attempts is ambiguous, not failed. */
  afterPublish?: boolean;
}): StepOutcome {
  const { result, target, now, config } = input;
  const secrets = input.secrets ?? [];
  const clean = (s: string) => redact(s, secrets);
  switch (result.kind) {
    case "continue":
      return {
        outcome: "continue",
        error: null,
        patch: {
          ...RELEASED,
          status: "publishing",
          stepState: result.state ?? null,
          attemptCount: 0,
          lastError: null,
          nextAttemptAt: new Date(Math.max(now.getTime(), result.notBefore?.getTime() ?? 0)),
        },
      };
    case "done":
      return {
        outcome: "done",
        error: null,
        patch: {
          ...RELEASED,
          status: "published",
          externalId: result.externalId,
          externalUrl: result.url ?? null,
          publishedAt: now,
          stepState: null,
          nextAttemptAt: null,
          lastError: null,
        },
      };
    case "retryable_error": {
      const error = clean(result.error);
      const attemptCount = target.attemptCount + 1;
      if (attemptCount >= config.maxAttempts && input.afterPublish) {
        const message = `${error} ${AFTER_PUBLISH_SUFFIX}`;
        return {
          outcome: "ambiguous",
          error: message,
          patch: { ...RELEASED, status: "ambiguous", attemptCount, nextAttemptAt: null, lastError: message },
        };
      }
      if (attemptCount >= config.maxAttempts) {
        return {
          outcome: "retryable_error",
          error,
          patch: { ...RELEASED, status: "failed", attemptCount, nextAttemptAt: null, lastError: error },
        };
      }
      return {
        outcome: "retryable_error",
        error,
        patch: {
          ...RELEASED,
          status: target.stepState != null ? "publishing" : "scheduled",
          attemptCount,
          lastError: error,
          nextAttemptAt: nextRetryAt(now, attemptCount, config, result.notBefore),
        },
      };
    }
    case "fatal_error": {
      const error = clean(result.error);
      return {
        outcome: "fatal_error",
        error,
        patch: { ...RELEASED, status: "failed", nextAttemptAt: null, lastError: error },
      };
    }
    case "ambiguous": {
      const error = clean(result.error);
      return {
        outcome: "ambiguous",
        error,
        patch: { ...RELEASED, status: "ambiguous", nextAttemptAt: null, lastError: error },
      };
    }
  }
}

export interface RecordInput {
  projectId: string;
  postId: string;
  targetId: string;
  /** With `providerKey`, lets an applied result write its activity event in this transaction. */
  socialAccountId?: string;
  providerKey?: string;
  token: string;
  step: string;
  outcome: StepOutcome;
  requestSummary?: Record<string, unknown>;
  responseSummary?: Record<string, unknown>;
  durationMs?: number;
  tickId: string;
  now: Date;
  secrets?: readonly string[];
}

/**
 * Record transaction (project-pinned): post lock, then the target guarded by the lease token.
 * No row updated means the lease was lost: only a `stale_result` attempt is written (US2-AS4).
 * Returns whether the result was applied.
 */
export function recordStepResult(input: RecordInput): Promise<boolean> {
  const secrets = input.secrets ?? [];
  return forSchedulerProject(input.projectId).transaction(async (tx) => {
    await tx.posts.lockForUpdate(input.postId);
    const updated = await tx.targets.update(input.targetId, input.outcome.patch, { leaseOwner: input.token });
    const applied = updated !== null;
    await tx.attempts.insert({
      postTargetId: input.targetId,
      step: input.step,
      outcome: applied ? input.outcome.outcome : "stale_result",
      requestSummary: redact(input.requestSummary ?? {}, secrets),
      responseSummary: redact(input.responseSummary ?? {}, secrets),
      error: applied ? input.outcome.error : null,
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      tickId: input.tickId,
      at: input.now,
    });
    if (applied) {
      if (input.socialAccountId && input.providerKey) {
        const event = eventForStep({
          outcome: input.outcome,
          now: input.now,
          target: { id: input.targetId, postId: input.postId, socialAccountId: input.socialAccountId },
          account: { id: input.socialAccountId, providerKey: input.providerKey },
        });
        if (event) await tx.activity.insert(event);
      }
      await applyDerivedStatus(tx, input.postId);
    }
    return applied;
  });
}
