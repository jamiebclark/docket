import type { LlmFailureKind } from "./types";

/** One fixed sentence per failure kind. SDK error text never reaches a user. */
export const LLM_FAILURE_MESSAGES: Record<LlmFailureKind, string> = {
  invalid_output: "The model's answer could not be read.",
  refused: "The model declined to write this post.",
  incomplete: "The model's answer was cut off.",
  timeout: "The model took too long to answer.",
  rate_limited: "The model provider is rate limiting requests. Try again in a minute.",
  unavailable: "The model provider is unavailable. Try again shortly.",
  auth: "The model provider refused Docket's API key. Check the LLM settings.",
  bad_request: "The model provider rejected the request. Check LLM_MODEL.",
};

export function llmFailureMessage(kind: LlmFailureKind): string {
  return LLM_FAILURE_MESSAGES[kind];
}
