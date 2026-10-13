import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { LlmUsageInsert } from "../../../src/server/dal/llm-usage";
import { closeDb } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";

afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(closeDb);

const BASE: Omit<LlmUsageInsert, "calledAt" | "credentialSource" | "inputTokens" | "outputTokens"> = {
  purpose: "generate.single",
  provider: "openai",
  model: "model-a",
  ok: true,
  failureKind: null,
  latencyMs: 10,
};

function row(over: Partial<LlmUsageInsert> & { calledAt: Date }): LlmUsageInsert {
  return { ...BASE, credentialSource: "install", inputTokens: 1000, outputTokens: 500, ...over };
}

/** `getLlmRates()` is memoised per module instance (contracts/config.md §3), so load a fresh
 * `usage.ts` after changing the env, the same technique `tick-endpoint.test.ts` uses. */
async function freshGetProjectUsage() {
  vi.resetModules();
  return (await import("../../../src/server/services/usage")).getProjectUsage;
}

describe("the Usage report's money (US2)", () => {
  it("LLM_RATES unset: no currency code and no money figure, token figures unchanged (SC-003)", async () => {
    vi.stubEnv("LLM_RATES", "");
    vi.stubEnv("LLM_RATE_CURRENCY", "");
    const getProjectUsage = await freshGetProjectUsage();
    const { scope } = await postsEnv();
    const now = new Date();
    await scope.llmUsage.record([row({ calledAt: now })]);

    const view = await getProjectUsage(scope, "all");
    expect(view.money).toBeUndefined();
    expect(view.totals.inputTokens).toBe(1000);
    expect(view.totals.outputTokens).toBe(500);
  });

  it("one rate configured: the estimate equals inputTokens × inputRate + outputTokens × outputRate (FR-019)", async () => {
    vi.stubEnv("LLM_RATES", "openai:model-a=0.25/2.00");
    vi.stubEnv("LLM_RATE_CURRENCY", "USD");
    const getProjectUsage = await freshGetProjectUsage();
    const { scope } = await postsEnv();
    const now = new Date();
    await scope.llmUsage.record([row({ calledAt: now, inputTokens: 1_000_000, outputTokens: 1_000_000 })]);

    const view = await getProjectUsage(scope, "all");
    expect(view.money).toBeDefined();
    expect(view.money?.currency).toBe("USD");
    const modelRow = view.byModel.find((m) => m.model === "model-a");
    expect(modelRow?.estimateMicros).toBe(250_000 + 2_000_000);
    expect(view.money?.totalMicros).toBe(250_000 + 2_000_000);
  });

  it("a rate of 0 renders 0.00 <CODE> and is distinguishable from no rate configured (FR-012)", async () => {
    vi.stubEnv("LLM_RATES", "openai:model-a=0/0");
    vi.stubEnv("LLM_RATE_CURRENCY", "USD");
    const getProjectUsage = await freshGetProjectUsage();
    const { scope } = await postsEnv();
    const now = new Date();
    await scope.llmUsage.record([row({ calledAt: now })]);

    const view = await getProjectUsage(scope, "all");
    const modelRow = view.byModel.find((m) => m.model === "model-a");
    expect(modelRow?.estimateMicros).toBe(0);
    expect(modelRow?.rateIsZero).toBe(true);
  });

  it("changing LLM_RATES and re-reading changes the past period's estimate, with row count and bytes unchanged (SC-007)", async () => {
    vi.stubEnv("LLM_RATES", "");
    vi.stubEnv("LLM_RATE_CURRENCY", "");
    let getProjectUsage = await freshGetProjectUsage();
    const { scope } = await postsEnv();
    const now = new Date();
    await scope.llmUsage.record([row({ calledAt: now, inputTokens: 1_000_000, outputTokens: 1_000_000 })]);

    const before = await getProjectUsage(scope, "all");
    expect(before.money).toBeUndefined();
    expect(before.totals.calls).toBe(1);

    vi.stubEnv("LLM_RATES", "openai:model-a=1.00/1.00");
    vi.stubEnv("LLM_RATE_CURRENCY", "USD");
    getProjectUsage = await freshGetProjectUsage();
    const after = await getProjectUsage(scope, "all");
    expect(after.money?.totalMicros).toBe(2_000_000);
    expect(after.totals.calls).toBe(before.totals.calls);
    expect(after.totals.inputTokens).toBe(before.totals.inputTokens);
    expect(after.totals.outputTokens).toBe(before.totals.outputTokens);
  });

  it("a render containing a currency code always carries ESTIMATE_DISCLAIMER, never spend/cost/charged/billed (SC-005)", async () => {
    vi.stubEnv("LLM_RATES", "openai:model-a=0.25/2.00");
    vi.stubEnv("LLM_RATE_CURRENCY", "USD");
    const mod = await import("../../../src/server/services/usage");
    expect(mod.ESTIMATE_DISCLAIMER.length).toBeGreaterThan(0);
    expect(mod.ESTIMATE_DISCLAIMER).not.toMatch(/\b(spend|cost|charged|billed)\b/i);
  });
});

describe("validateConfiguration and the rate warnings (FR-011)", () => {
  it("a duplicate pair, a negative price, a non-numeric price, a missing currency and a malformed currency are each a warning, never an issue, and runStartup does not exit", async () => {
    const { validateConfiguration } = await import("../../../src/server/startup/validate");
    const cases: Record<string, string | undefined>[] = [
      { LLM_RATES: "openai:model-a=1/1 openai:model-a=2/2", LLM_RATE_CURRENCY: "USD" },
      { LLM_RATES: "openai:model-a=-1/1", LLM_RATE_CURRENCY: "USD" },
      { LLM_RATES: "openai:model-a=free/1", LLM_RATE_CURRENCY: "USD" },
      { LLM_RATES: "openai:model-a=1/1" },
      { LLM_RATES: "openai:model-a=1/1", LLM_RATE_CURRENCY: "US1" },
    ];
    for (const over of cases) {
      const r = validateConfiguration({
        DATABASE_URL: "postgres://u:p@localhost:5432/db",
        BETTER_AUTH_SECRET: "x".repeat(40),
        BETTER_AUTH_URL: "http://localhost:3000",
        CREDENTIALS_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        ...over,
      });
      expect(r.warnings.length, JSON.stringify(over)).toBeGreaterThan(0);
      expect(r.issues.some((i) => i.name === "LLM_RATES" || i.name === "LLM_RATE_CURRENCY"), JSON.stringify(over)).toBe(false);
      expect(r.ok).toBe(true);
    }

    const { runStartup } = await import("../../../src/server/startup");
    const exit = vi.fn();
    await runStartup({
      env: {
        DATABASE_URL: "postgres://u:p@localhost:5432/db",
        BETTER_AUTH_SECRET: "x".repeat(40),
        BETTER_AUTH_URL: "http://localhost:3000",
        CREDENTIALS_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        LLM_RATES: "openai:model-a=-1/1",
        LLM_RATE_CURRENCY: "USD",
      },
      exit: exit as never,
      log: () => {},
      migrate: async () => {},
      bootstrap: async () => ({}),
    });
    expect(exit).not.toHaveBeenCalled();
  });
});
