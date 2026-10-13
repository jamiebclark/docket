import { expect, test } from "vitest";
import { IMAGE_FAILURE_MESSAGES, imageFailureMessage } from "./image-messages";
import { LLM_FAILURE_MESSAGES } from "./messages";
import { LLM_FAILURE_KINDS } from "./types";

test("both failure-sentence maps are keyed by every failure kind", () => {
  expect(Object.keys(LLM_FAILURE_MESSAGES).sort()).toEqual([...LLM_FAILURE_KINDS].sort());
  expect(Object.keys(IMAGE_FAILURE_MESSAGES).sort()).toEqual([...LLM_FAILURE_KINDS].sort());
  for (const kind of LLM_FAILURE_KINDS) expect(imageFailureMessage(kind).length).toBeGreaterThan(10);
});

test("the image sentences say so, not what a text refusal says", () => {
  expect(imageFailureMessage("refused")).toMatch(/image/i);
  expect(imageFailureMessage("refused")).not.toBe("The model declined to write this post.");
});

test("the credit_exhausted sentence names credit and no provider", () => {
  const message = imageFailureMessage("credit_exhausted");
  expect(message).toMatch(/credit/i);
  expect(message).not.toMatch(/anthropic|openai|claude|gpt/i);
});
