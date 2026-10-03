import type { ClaimDecision } from "../dal/scheduler";
import type { TargetPatch, TargetRecord } from "../dal/targets";
import type { SchedulerConfig } from "./config";

type Attempts = NonNullable<ClaimDecision["attempts"]>;

export type Recovery =
  /** The target had no step in flight: nothing to recover. */
  | { kind: "none" }
  /** The step is safe to repeat: carry the attempt row(s) and patch into the normal claim path. */
  | { kind: "retry"; attemptCount: number; attempts: Attempts; patch: TargetPatch }
  /** The target is settled (ambiguous, or failed after too many interruptions). */
  | { kind: "settled"; outcome: "ambiguous" | "failed"; patch: TargetPatch; attempts: Attempts };

/**
 * Handles a claimed target whose lease expired while a step was in flight (FR-035, D5).
 * A step that could have published is never repeated; a safe one is retried with the attempt counted.
 */
export function recoverExpiredLease(target: TargetRecord, config: SchedulerConfig, tickId: string): Recovery {
  if (target.inFlightStep === null) return { kind: "none" };
  if (target.inFlightMayPublish) {
    return {
      kind: "settled",
      outcome: "ambiguous",
      patch: { status: "ambiguous", nextAttemptAt: null, lastError: "The publish step was interrupted and may have gone out." },
      attempts: [
        { step: target.inFlightStep, outcome: "recovered_ambiguous", tickId, error: "Lease expired during a step that may have published." },
      ],
    };
  }
  const attemptCount = target.attemptCount + 1;
  const attempts: Attempts = [
    { step: target.inFlightStep, outcome: "recovered_retry", tickId, error: "Lease expired; the step is being retried." },
  ];
  if (attemptCount >= config.maxAttempts) {
    return {
      kind: "settled",
      outcome: "failed",
      patch: { status: "failed", attemptCount, nextAttemptAt: null, lastError: "Publishing was interrupted too many times." },
      attempts,
    };
  }
  return { kind: "retry", attemptCount, attempts, patch: { attemptCount } };
}
