import { describe, expect, test } from "vitest";
import { estimateMicros, formatMoney, parseLlmRates, rateFor } from "./rates";

describe("parseLlmRates", () => {
  test("neither variable set", () => {
    expect(parseLlmRates({})).toEqual({ entries: [], currency: null, problems: [] });
  });

  test("valid rates, valid currency", () => {
    const r = parseLlmRates({ LLM_RATES: "openai:gpt-x=0.25/2.00", LLM_RATE_CURRENCY: "usd" });
    expect(r.problems).toEqual([]);
    expect(r.currency).toBe("USD");
    expect(r.entries).toEqual([
      { provider: "openai", model: "gpt-x", inputMicrosPerMillion: 250_000, outputMicrosPerMillion: 2_000_000 },
    ]);
  });

  test("multiple entries, space and comma separated", () => {
    const r = parseLlmRates({
      LLM_RATES: "openai:gpt-x=0.25/2.00, anthropic:claude-x=3.00/15.00",
      LLM_RATE_CURRENCY: "USD",
    });
    expect(r.problems).toEqual([]);
    expect(r.entries).toHaveLength(2);
  });

  test("rates valid, currency absent", () => {
    const r = parseLlmRates({ LLM_RATES: "openai:gpt-x=0.25/2.00" });
    expect(r).toEqual({
      entries: [],
      currency: null,
      problems: [{ name: "LLM_RATE_CURRENCY", reason: "required when LLM_RATES is set" }],
    });
  });

  test("rates valid, currency malformed", () => {
    const r = parseLlmRates({ LLM_RATES: "openai:gpt-x=0.25/2.00", LLM_RATE_CURRENCY: "US1" });
    expect(r.entries).toEqual([]);
    expect(r.currency).toBeNull();
    expect(r.problems).toEqual([{ name: "LLM_RATE_CURRENCY", reason: "must be three letters" }]);
  });

  test("malformed entry (no '=')", () => {
    const r = parseLlmRates({ LLM_RATES: "openai:gpt-x0.25/2.00", LLM_RATE_CURRENCY: "USD" });
    expect(r.entries).toEqual([]);
    expect(r.currency).toBeNull();
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]?.name).toBe("LLM_RATES");
  });

  test("duplicate (provider, model) pair", () => {
    const r = parseLlmRates({
      LLM_RATES: "openai:gpt-x=0.25/2.00 openai:gpt-x=1.00/1.00",
      LLM_RATE_CURRENCY: "USD",
    });
    expect(r.entries).toEqual([]);
    expect(r.currency).toBeNull();
    expect(r.problems).toEqual([{ name: "LLM_RATES", reason: "names the same provider and model twice" }]);
  });

  test("negative price", () => {
    const r = parseLlmRates({ LLM_RATES: "openai:gpt-x=-1/2.00", LLM_RATE_CURRENCY: "USD" });
    expect(r.entries).toEqual([]);
    expect(r.problems[0]?.name).toBe("LLM_RATES");
  });

  test("non-numeric price", () => {
    const r = parseLlmRates({ LLM_RATES: "openai:gpt-x=free/2.00", LLM_RATE_CURRENCY: "USD" });
    expect(r.entries).toEqual([]);
    expect(r.problems[0]?.name).toBe("LLM_RATES");
  });

  test("price with more than 6 decimal places", () => {
    const r = parseLlmRates({ LLM_RATES: "openai:gpt-x=0.1234567/2.00", LLM_RATE_CURRENCY: "USD" });
    expect(r.entries).toEqual([]);
    expect(r.problems[0]?.name).toBe("LLM_RATES");
  });

  test("unknown provider", () => {
    const r = parseLlmRates({ LLM_RATES: "gemini:gpt-x=0.25/2.00", LLM_RATE_CURRENCY: "USD" });
    expect(r.entries).toEqual([]);
    expect(r.problems).toEqual([{ name: "LLM_RATES", reason: "provider must be openai or anthropic" }]);
  });

  test("currency set, rates absent, currency malformed", () => {
    const r = parseLlmRates({ LLM_RATE_CURRENCY: "US1" });
    expect(r).toEqual({
      entries: [],
      currency: null,
      problems: [{ name: "LLM_RATE_CURRENCY", reason: "must be three letters" }],
    });
  });

  test("currency set, rates absent, currency valid", () => {
    const r = parseLlmRates({ LLM_RATE_CURRENCY: "USD" });
    expect(r).toEqual({ entries: [], currency: null, problems: [] });
  });

  test("zero price is allowed", () => {
    const r = parseLlmRates({ LLM_RATES: "openai:gpt-x=0/0", LLM_RATE_CURRENCY: "USD" });
    expect(r.problems).toEqual([]);
    expect(r.entries).toEqual([
      { provider: "openai", model: "gpt-x", inputMicrosPerMillion: 0, outputMicrosPerMillion: 0 },
    ]);
  });
});

describe("rateFor", () => {
  test("exact match only", () => {
    const rates = parseLlmRates({ LLM_RATES: "openai:gpt-x=0.25/2.00", LLM_RATE_CURRENCY: "USD" });
    expect(rateFor(rates, "openai", "gpt-x")).toEqual({
      provider: "openai",
      model: "gpt-x",
      inputMicrosPerMillion: 250_000,
      outputMicrosPerMillion: 2_000_000,
    });
    expect(rateFor(rates, "openai", "gpt-y")).toBeNull();
    expect(rateFor(rates, "anthropic", "gpt-x")).toBeNull();
  });
});

describe("estimateMicros", () => {
  test("exact-integer arithmetic at realistic volumes", () => {
    expect(estimateMicros(1_000_000, 250_000)).toBe(250_000);
    expect(estimateMicros(1, 250_000)).toBe(0);
    expect(estimateMicros(10_000_000_000, 1_000_000_000)).toBe(10_000_000_000_000);
  });
});

describe("formatMoney", () => {
  test("renders a typical amount", () => {
    expect(formatMoney(12_340_000, "USD")).toBe("12.34 USD");
  });

  test("a configured zero renders 0.00", () => {
    expect(formatMoney(0, "USD")).toBe("0.00 USD");
  });

  test("a non-zero amount rounding to zero renders under 0.01", () => {
    expect(formatMoney(1, "USD")).toBe("under 0.01 USD");
  });
});
