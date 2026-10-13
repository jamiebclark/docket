import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { LlmUsageInsert } from "../../../src/server/dal/llm-usage";
import { closeDb } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";

vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);
vi.mock("next/navigation", async () => ({
  ...(await import("../../helpers/actions")).navigationModule,
  usePathname: () => "/",
}));

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

  it("a render containing a currency code always carries ESTIMATE_DISCLAIMER, and no money figure is ever labelled spend/cost/charged/billed (SC-005)", async () => {
    const { scope, owner } = await postsEnv();
    const now = new Date();
    await scope.llmUsage.record([row({ calledAt: now })]);

    vi.resetModules();
    vi.stubEnv("LLM_RATES", "openai:model-a=0.25/2.00");
    vi.stubEnv("LLM_RATE_CURRENCY", "USD");
    const helpers = await import("../../helpers/actions");
    helpers.actAs(owner);
    const { ESTIMATE_DISCLAIMER } = await import("../../../src/server/services/usage");
    const { default: UsagePage } = await import("../../../src/app/p/[projectSlug]/settings/usage/page");

    const html = renderToStaticMarkup(
      (await UsagePage({
        params: Promise.resolve({ projectSlug: scope.project.slug }),
        searchParams: Promise.resolve({}),
      })) as never,
    );
    helpers.actAs(null);

    // React escapes apostrophes to `&#x27;` in static markup.
    const disclaimerAsRendered = ESTIMATE_DISCLAIMER.replace(/'/g, "&#x27;");
    expect(html).toContain("USD");
    expect(html).toContain(disclaimerAsRendered);
    // SC-005/FR-020: the four forbidden words may never *label a money figure*. The disclaimer's own
    // prose is allowed to describe what the provider did (M12) — it is excluded from this check.
    const withoutDisclaimer = html.replace(disclaimerAsRendered, "");
    expect(withoutDisclaimer).not.toMatch(/\b(spend|cost|charged|billed)\b/i);
  });
});

describe("an unpriced model never produces a confident wrong number (US3)", () => {
  it("rate for model A only, usage on A and B: total covers A alone, excludes B verbatim with its own calls and tokens (SC-004)", async () => {
    vi.stubEnv("LLM_RATES", "openai:model-a=1.00/1.00");
    vi.stubEnv("LLM_RATE_CURRENCY", "USD");
    const getProjectUsage = await freshGetProjectUsage();
    const { scope } = await postsEnv();
    const now = new Date();
    await scope.llmUsage.record([
      row({ calledAt: now, model: "model-a", inputTokens: 1_000_000, outputTokens: 1_000_000 }),
      row({ calledAt: now, model: "model-b", inputTokens: 500_000, outputTokens: 500_000 }),
    ]);

    const view = await getProjectUsage(scope, "all");
    expect(view.money?.totalMicros).toBe(2_000_000);
    expect(view.money?.pricedModels).toBe(1);
    expect(view.money?.noPricedUsage).toBe(false);
    expect(view.money?.excluded).toEqual([{ provider: "openai", model: "model-b", calls: 1, tokens: 1_000_000 }]);
    // Would be 3_000_000 if B's tokens were folded into the total at A's rate — they are not (SC-004).
    expect(view.money?.totalMicros).not.toBe(3_000_000);
  });

  it("rates configured but none matching this period's models: no total, with the reason named (FR-024)", async () => {
    vi.stubEnv("LLM_RATES", "openai:model-a=1.00/1.00");
    vi.stubEnv("LLM_RATE_CURRENCY", "USD");
    const getProjectUsage = await freshGetProjectUsage();
    const { scope } = await postsEnv();
    const now = new Date();
    await scope.llmUsage.record([row({ calledAt: now, model: "model-b", inputTokens: 1000, outputTokens: 500 })]);

    const view = await getProjectUsage(scope, "all");
    expect(view.money?.noPricedUsage).toBe(true);
    expect(view.money?.pricedModels).toBe(0);
    expect(view.money?.totalMicros).toBe(0);
    expect(view.money?.excluded).toEqual([{ provider: "openai", model: "model-b", calls: 1, tokens: 1500 }]);
  });

  it("a rate differing only by case or a trailing suffix does not match, nor does the right provider with a different model (FR-010)", async () => {
    vi.stubEnv("LLM_RATES", "openai:model-a=1.00/1.00");
    vi.stubEnv("LLM_RATE_CURRENCY", "USD");
    const getProjectUsage = await freshGetProjectUsage();
    const { scope } = await postsEnv();
    const now = new Date();
    await scope.llmUsage.record([
      row({ calledAt: now, model: "Model-A", inputTokens: 1000, outputTokens: 500 }),
      row({ calledAt: now, model: "model-a-preview", inputTokens: 1000, outputTokens: 500 }),
      row({ calledAt: now, model: "model-a", provider: "anthropic", inputTokens: 1000, outputTokens: 500 }),
    ]);

    const view = await getProjectUsage(scope, "all");
    expect(view.money?.pricedModels).toBe(0);
    expect(view.money?.noPricedUsage).toBe(true);
    expect(view.money?.excluded).toHaveLength(3);
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
