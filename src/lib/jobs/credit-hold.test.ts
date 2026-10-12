import { describe, expect, it } from "vitest";
import {
  CREDIT_HOLD_ACTION,
  CREDIT_HOLD_CAUSE,
  CREDIT_HOLD_RESUME,
  CREDIT_HOLD_SINCE_LABEL,
  CREDIT_HOLD_WAITING,
} from "./credit-hold";

const STRINGS = [CREDIT_HOLD_CAUSE, CREDIT_HOLD_WAITING, CREDIT_HOLD_RESUME, CREDIT_HOLD_ACTION, CREDIT_HOLD_SINCE_LABEL];
const COMBINED = STRINGS.join(" ");

describe("credit-hold wording", () => {
  it("is five fixed, non-empty strings", () => {
    expect(STRINGS).toHaveLength(5);
    for (const s of STRINGS) expect(s.length).toBeGreaterThan(0);
  });

  it("names credit and quota", () => {
    expect(COMBINED).toMatch(/credit/i);
    expect(COMBINED).toMatch(/quota/i);
  });

  it("never names a provider", () => {
    expect(COMBINED).not.toMatch(/openai|anthropic|claude|gpt/i);
  });

  it("never contains a key-shaped string", () => {
    expect(COMBINED).not.toMatch(/sk-[a-zA-Z0-9_-]{8,}/);
    expect(COMBINED).not.toMatch(/[a-zA-Z0-9_-]{32,}/);
  });
});
