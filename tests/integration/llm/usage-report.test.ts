import { afterAll, describe, expect, it } from "vitest";
import type { LlmUsageInsert } from "../../../src/server/dal/llm-usage";
import { closeDb } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";

afterAll(closeDb);

const BASE: Omit<LlmUsageInsert, "calledAt" | "credentialSource" | "inputTokens" | "outputTokens"> = {
  purpose: "generate.single",
  provider: "openai",
  model: "fake-model",
  ok: true,
  failureKind: null,
  latencyMs: 10,
};

function row(over: Partial<LlmUsageInsert> & { calledAt: Date }): LlmUsageInsert {
  return { ...BASE, credentialSource: "install", inputTokens: 100, outputTokens: 50, ...over };
}

describe("the usage report adds up", () => {
  it("totals.calls equals the sum across byModel and byPurpose, with matching token sums", async () => {
    const { scope } = await postsEnv();
    const now = new Date();
    await scope.llmUsage.record([
      row({ calledAt: now, purpose: "generate.single", provider: "openai", model: "model-a", inputTokens: 100, outputTokens: 50 }),
      row({ calledAt: now, purpose: "generate.job_item", provider: "anthropic", model: "model-b", inputTokens: 20, outputTokens: 10 }),
      row({ calledAt: now, purpose: "generate.job_item", provider: "openai", model: "model-a", inputTokens: 5, outputTokens: 5 }),
    ]);
    const window = { from: null, to: null };
    const [totals, byModel, byPurpose] = await Promise.all([
      scope.llmUsage.summary(window),
      scope.llmUsage.byModel(window),
      scope.llmUsage.byPurpose(window),
    ]);
    expect(totals.calls).toBe(3);
    expect(byModel.reduce((n, r) => n + r.calls, 0)).toBe(totals.calls);
    expect(byPurpose.reduce((n, r) => n + r.calls, 0)).toBe(totals.calls);
    expect(totals.inputTokens).toBe(125);
    expect(totals.outputTokens).toBe(65);
    expect(byModel.reduce((n, r) => n + r.inputTokens, 0)).toBe(totals.inputTokens);
    expect(byModel.reduce((n, r) => n + r.outputTokens, 0)).toBe(totals.outputTokens);
  });

  it("the credential-source split: an earlier install-credential batch keeps its attribution after a later project key is stored and removed", async () => {
    const { scope } = await postsEnv();
    const now = new Date();
    const installRows = Array.from({ length: 10 }, (_, i) =>
      row({ calledAt: new Date(now.getTime() + i), credentialSource: "install" }),
    );
    await scope.llmUsage.record(installRows);
    const projectRows = Array.from({ length: 5 }, (_, i) =>
      row({ calledAt: new Date(now.getTime() + 100 + i), credentialSource: "project" }),
    );
    await scope.llmUsage.record(projectRows);

    const totals = await scope.llmUsage.summary({ from: null, to: null });
    expect(totals.calls).toBe(15);
    expect(totals.installCredentialCalls).toBe(10);
    expect(totals.projectCredentialCalls).toBe(5);
  });

  it("a period of only no-count calls: calls is non-zero, both token totals are 0, callsWithoutCounts equals calls", async () => {
    const { scope } = await postsEnv();
    const now = new Date();
    await scope.llmUsage.record([
      row({ calledAt: now, inputTokens: null, outputTokens: null }),
      row({ calledAt: now, inputTokens: null, outputTokens: null }),
    ]);
    const totals = await scope.llmUsage.summary({ from: null, to: null });
    expect(totals.calls).toBe(2);
    expect(totals.inputTokens).toBe(0);
    expect(totals.outputTokens).toBe(0);
    expect(totals.callsWithoutCounts).toBe(2);
  });

  it("a half-open window [from, to): excludes one ms before from, includes at from, excludes at to", async () => {
    const { scope } = await postsEnv();
    const from = new Date("2026-05-01T00:00:00.000Z");
    const to = new Date("2026-05-02T00:00:00.000Z");
    await scope.llmUsage.record([
      row({ calledAt: new Date(from.getTime() - 1) }),
      row({ calledAt: from }),
      row({ calledAt: to }),
    ]);
    const totals = await scope.llmUsage.summary({ from, to });
    expect(totals.calls).toBe(1);
  });
});
