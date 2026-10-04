import { expect, test } from "vitest";
import { llmFailureMessage, LLM_FAILURE_MESSAGES } from "./messages";
import { LLM_FAILURE_KINDS } from "./types";

test("all eight failure kinds have a message", () => {
  expect(LLM_FAILURE_KINDS).toHaveLength(8);
  expect(Object.keys(LLM_FAILURE_MESSAGES).sort()).toEqual([...LLM_FAILURE_KINDS].sort());
  for (const kind of LLM_FAILURE_KINDS) expect(llmFailureMessage(kind).length).toBeGreaterThan(10);
});
