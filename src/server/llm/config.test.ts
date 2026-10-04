import { describe, expect, test } from "vitest";
import { parseLlmConfig } from "./config";

const KEY = "sk-test-FAKEKEY1234567890";
const base = { LLM_PROVIDER: "openai", LLM_MODEL: "some-model", OPENAI_API_KEY: KEY };

describe("parseLlmConfig", () => {
  test("unset provider gives exactly one problem", () => {
    const r = parseLlmConfig({});
    expect(r).toEqual({ ok: false, problems: [{ name: "LLM_PROVIDER", reason: "not set; generation is disabled" }] });
  });

  test("unknown provider", () => {
    const r = parseLlmConfig({ LLM_PROVIDER: "gemini" });
    expect(r).toEqual({ ok: false, problems: [{ name: "LLM_PROVIDER", reason: "must be openai or anthropic" }] });
  });

  test("names the missing model and key", () => {
    const r = parseLlmConfig({ LLM_PROVIDER: "anthropic" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.problems.map((p) => p.name)).toEqual(["LLM_MODEL", "ANTHROPIC_API_KEY"]);
      expect(r.problems[1]?.reason).toBe("required when LLM_PROVIDER=anthropic");
    }
  });

  test("valid config with defaults", () => {
    const r = parseLlmConfig(base);
    expect(r).toEqual({
      ok: true,
      config: { provider: "openai", model: "some-model", apiKey: KEY, timeoutMs: 90_000, maxOutputTokens: 4000 },
    });
  });

  test("the unselected provider's key is ignored", () => {
    const r = parseLlmConfig({ ...base, ANTHROPIC_API_KEY: "" });
    expect(r.ok).toBe(true);
    const r2 = parseLlmConfig({ LLM_PROVIDER: "anthropic", LLM_MODEL: "m", OPENAI_API_KEY: KEY });
    expect(r2.ok).toBe(false);
  });

  test("model rules", () => {
    expect(parseLlmConfig({ ...base, LLM_MODEL: "has space" }).ok).toBe(false);
    expect(parseLlmConfig({ ...base, LLM_MODEL: "x".repeat(201) }).ok).toBe(false);
    expect(parseLlmConfig({ ...base, LLM_MODEL: "x".repeat(200) }).ok).toBe(true);
  });

  test.each([
    ["LLM_TIMEOUT_SECONDS", "9", false],
    ["LLM_TIMEOUT_SECONDS", "10", true],
    ["LLM_TIMEOUT_SECONDS", "600", true],
    ["LLM_TIMEOUT_SECONDS", "601", false],
    ["LLM_TIMEOUT_SECONDS", "abc", false],
    ["LLM_MAX_OUTPUT_TOKENS", "255", false],
    ["LLM_MAX_OUTPUT_TOKENS", "256", true],
    ["LLM_MAX_OUTPUT_TOKENS", "32000", true],
    ["LLM_MAX_OUTPUT_TOKENS", "32001", false],
  ])("%s=%s ok=%s", (name, value, ok) => {
    expect(parseLlmConfig({ ...base, [name]: value }).ok).toBe(ok);
  });

  test("timeout and tokens are applied", () => {
    const r = parseLlmConfig({ ...base, LLM_TIMEOUT_SECONDS: "30", LLM_MAX_OUTPUT_TOKENS: "1000" });
    expect(r.ok && r.config.timeoutMs).toBe(30_000);
    expect(r.ok && r.config.maxOutputTokens).toBe(1000);
  });

  test("no key value appears in problems", () => {
    const r = parseLlmConfig({ ...base, LLM_MODEL: "bad model", LLM_TIMEOUT_SECONDS: "1" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(JSON.stringify(r.problems)).not.toContain(KEY);
  });
});
