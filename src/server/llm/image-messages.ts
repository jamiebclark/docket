import type { LlmFailureKind } from "./types";

/**
 * A parallel fixed-sentence map, because the text sentences are wrong here (G13): "The model
 * declined to write this post." is not what happened.
 */
export const IMAGE_FAILURE_MESSAGES: Record<LlmFailureKind, string> = {
  invalid_output: "The image provider's answer could not be read.",
  refused: "The image provider declined to make this image.",
  incomplete: "The image provider's answer was cut off.",
  timeout: "The image provider took too long to answer.",
  rate_limited: "The image provider is rate limiting requests. Try again in a minute.",
  unavailable: "The image provider is unavailable. Try again shortly.",
  auth: "The image provider refused Docket's API key. Check the image generation settings.",
  bad_request: "The image provider rejected the request. Check LLM_IMAGE_MODEL and the shape you asked for.",
  credit_exhausted:
    "The image provider refused: the account has no credit or quota left. Add credit to the provider account.",
};

export function imageFailureMessage(kind: LlmFailureKind): string {
  return IMAGE_FAILURE_MESSAGES[kind];
}
