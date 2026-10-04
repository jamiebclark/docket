import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeLlm } from "../../../tests/helpers/fake-llm";
import { getLlm, getLlmStatus, LlmNotConfiguredError, setLlmForTests } from "./index";

const NAMES = ["LLM_PROVIDER", "LLM_MODEL", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "LLM_TIMEOUT_SECONDS", "LLM_MAX_OUTPUT_TOKENS"];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const n of NAMES) {
    saved[n] = process.env[n];
    delete process.env[n];
  }
});
afterEach(() => {
  for (const n of NAMES) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  }
  setLlmForTests(null);
});

describe("llm selection", () => {
  it("is unconfigured with one problem when nothing is set, and getLlm names the missing settings", () => {
    expect(getLlmStatus()).toMatchObject({ configured: false, problems: [{ name: "LLM_PROVIDER" }] });
    expect(() => getLlm()).toThrow(LlmNotConfiguredError);
    expect(() => getLlm()).toThrow("Generation is not configured. Set: LLM_PROVIDER, LLM_MODEL, OPENAI_API_KEY.");
  });

  it("names only the missing settings, never values", () => {
    process.env.LLM_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-SECRETVALUE";
    try {
      getLlm();
      throw new Error("expected throw");
    } catch (e) {
      expect((e as Error).message).toBe("Generation is not configured. Set: LLM_MODEL.");
    }
  });

  it("selects the provider from the environment", () => {
    process.env.LLM_PROVIDER = "openai";
    process.env.LLM_MODEL = "some-model";
    process.env.OPENAI_API_KEY = "sk-x";
    expect(getLlmStatus()).toEqual({ configured: true, provider: "openai", model: "some-model" });
    expect(getLlm()).toMatchObject({ name: "openai", model: "some-model" });
    process.env.LLM_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "sk-y";
    expect(getLlm()).toMatchObject({ name: "anthropic" });
  });

  it("names LLM_MODEL when the provider is set but the model is missing", () => {
    process.env.LLM_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "sk-y";
    expect(getLlmStatus()).toMatchObject({ configured: false, problems: [{ name: "LLM_MODEL" }] });
    expect(() => getLlm()).toThrow("Generation is not configured. Set: LLM_MODEL.");
  });

  it("names the matching key for each provider", () => {
    process.env.LLM_PROVIDER = "openai";
    process.env.LLM_MODEL = "m";
    expect(() => getLlm()).toThrow("Set: OPENAI_API_KEY.");
    process.env.LLM_PROVIDER = "anthropic";
    process.env.OPENAI_API_KEY = "sk-x"; // the other provider's key does not count
    expect(() => getLlm()).toThrow("Set: ANTHROPIC_API_KEY.");
  });

  it("names an unknown provider", () => {
    process.env.LLM_PROVIDER = "gemini";
    expect(getLlmStatus()).toMatchObject({ configured: false, problems: [{ name: "LLM_PROVIDER" }] });
    expect(() => getLlm()).toThrow(LlmNotConfiguredError);
  });

  it("picks up a config change without a restart", () => {
    process.env.LLM_PROVIDER = "openai";
    process.env.LLM_MODEL = "a";
    process.env.OPENAI_API_KEY = "sk-x";
    expect(getLlm()).toMatchObject({ name: "openai", model: "a" });
    process.env.LLM_MODEL = "b";
    expect(getLlm()).toMatchObject({ name: "openai", model: "b" });
  });

  it("the test seam overrides the environment", () => {
    const fake = createFakeLlm([]);
    setLlmForTests(fake);
    expect(getLlm()).toBe(fake);
    expect(getLlmStatus()).toEqual({ configured: true, provider: "openai", model: "fake-model" });
    setLlmForTests(null);
    expect(getLlmStatus().configured).toBe(false);
  });

  it("the seam refuses to work outside test", () => {
    const prev = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV = "production";
    try {
      expect(() => setLlmForTests(null)).toThrow();
    } finally {
      (process.env as Record<string, string>).NODE_ENV = prev!;
    }
  });
});
