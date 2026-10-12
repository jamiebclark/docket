import * as clock from "../../dal/clock";
import { clearCreditHold, holdCredit } from "../../dal/credit-holds";
import type { LlmProvider, LlmRequest, LlmResult } from "../../llm/types";

/**
 * The provider, with credit-hold tracking (FR-017). Delegates `generate` and returns its result unchanged;
 * in between, a billing refusal sets or refreshes the owner's hold and every other outcome clears it.
 * Hold-write failures are swallowed: a database hiccup must never turn a good generation into a failure,
 * and the runner's decision not to fail an item comes from `result.kind`, not from the table.
 */
export function withCreditHold(llm: LlmProvider, owner: string): LlmProvider {
  return {
    ...llm,
    async generate<T>(request: LlmRequest<T>): Promise<LlmResult<T>> {
      const result = await llm.generate(request);
      try {
        if (!result.ok && result.kind === "credit_exhausted") {
          await holdCredit(owner, await clock.now());
        } else {
          await clearCreditHold(owner);
        }
      } catch {
        // A database hiccup must never turn a good generation into a failure (FR-017).
      }
      return result;
    },
  };
}
