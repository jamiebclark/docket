// generation/failures: the audit trail of generations that produced nothing usable.
import { ForbiddenError } from "../../dal/errors";
import type { GenerationFailureRecord, NewGenerationFailure } from "../../dal/generation-failures";
import type { ProjectScope } from "../../dal/scope";
import { llmFailureMessage } from "../../llm/messages";
import type { LlmFailureKind } from "../../llm/types";

export const RECENT_FAILURES_MAX = 20;

/** Stores the fixed message for the kind, the attempts and the user's inputs; never a prompt or a key. */
export async function recordFailure(
  scope: ProjectScope,
  input: Omit<NewGenerationFailure, "message" | "kind" | "requestedByUserId"> & {
    kind: LlmFailureKind;
    message?: string;
  },
): Promise<GenerationFailureRecord> {
  const { message, ...rest } = input;
  return scope.generationFailures.insert({
    ...rest,
    message: message ?? llmFailureMessage(input.kind),
    requestedByUserId: scope.membership.userId,
  });
}

export async function listRecentFailures(
  scope: ProjectScope,
  opts: { limit?: number } = {},
): Promise<GenerationFailureRecord[]> {
  if (!scope.can({ post: ["view"] })) throw new ForbiddenError();
  const limit = Math.min(Math.max(opts.limit ?? RECENT_FAILURES_MAX, 1), RECENT_FAILURES_MAX);
  return scope.generationFailures.listRecent(limit);
}
