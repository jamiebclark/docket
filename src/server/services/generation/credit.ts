import * as clock from "../../dal/clock";
import { clearCreditHold, holdCredit } from "../../dal/credit-holds";
import type { ImageProvider, ImageProviderRequest, ImageProviderResult } from "../../llm/image-provider";
import type { LlmFailureKind, LlmProvider, LlmRequest, LlmResult } from "../../llm/types";

/**
 * The whole billing-hold decision, in one place (G10, FR-017). A billing refusal sets or refreshes the
 * owner's hold and every other outcome clears it. Hold-write failures are swallowed: a database hiccup
 * must never turn a good generation into a failure, and the runner's decision not to fail an item comes
 * from the result's `kind`, not from the table.
 */
export async function applyCreditOutcome(owner: string, kind: LlmFailureKind | null): Promise<void> {
  try {
    if (kind === "credit_exhausted") {
      await holdCredit(owner, await clock.now());
    } else {
      await clearCreditHold(owner);
    }
  } catch {
    // A database hiccup must never turn a good generation into a failure (FR-017).
  }
}

/** The provider, with credit-hold tracking (FR-017). Delegates `generate` and returns its result unchanged. */
export function withCreditHold(llm: LlmProvider, owner: string): LlmProvider {
  return {
    ...llm,
    async generate<T>(request: LlmRequest<T>): Promise<LlmResult<T>> {
      const result = await llm.generate(request);
      await applyCreditOutcome(owner, result.ok ? null : result.kind);
      return result;
    },
  };
}

/** The image provider, with the same credit-hold tracking (P8). Delegates and returns the result unchanged. */
export function withImageCreditHold(image: ImageProvider, owner: string): ImageProvider {
  return {
    ...image,
    async generate(request: ImageProviderRequest): Promise<ImageProviderResult> {
      const result = await image.generate(request);
      await applyCreditOutcome(owner, result.ok ? null : result.kind);
      return result;
    },
  };
}
