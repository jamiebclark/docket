import { expect, test } from "vitest";
import { llmFailureMessage, LLM_FAILURE_MESSAGES } from "./messages";
import { LLM_FAILURE_KINDS } from "./types";

test("all nine failure kinds have a message", () => {
  expect(LLM_FAILURE_KINDS).toHaveLength(9);
  expect(Object.keys(LLM_FAILURE_MESSAGES).sort()).toEqual([...LLM_FAILURE_KINDS].sort());
  for (const kind of LLM_FAILURE_KINDS) expect(llmFailureMessage(kind).length).toBeGreaterThan(10);
});

test("the credit_exhausted sentence names credit and no provider", () => {
  const message = llmFailureMessage("credit_exhausted");
  expect(message).toMatch(/credit/i);
  expect(message).not.toMatch(/anthropic|openai|claude|gpt/i);
});
