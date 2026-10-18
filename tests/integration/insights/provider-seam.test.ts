import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { listProviders } from "../../../src/providers/registry";

// After tests/integration/engagement/provider-seam.test.ts (FR-061, SC-013): the generic insights
// layer must be writable for a second platform by adding one provider folder and nothing else, so
// it must never name a provider key or a platform metric key.

const PROVIDER_KEYS = listProviders().map((p) => p.key);

const METRIC_KEYS = [
  ...new Set(
    listProviders().flatMap((p) => [
      ...(p.insights?.declaration.post?.map((k) => k.key) ?? []),
      ...(p.insights?.declaration.account?.map((k) => k.key) ?? []),
    ]),
  ),
];

const SEAM_MODULES = [
  "src/lib/insights/schedule.ts",
  "src/lib/insights/panel.ts",
  "src/server/scheduler/insights-poll.ts",
  "src/server/scheduler/insights-budget.ts",
  "src/server/dal/insights.ts",
  "src/server/dal/insights-claims.ts",
  "src/server/services/insights/retention.ts",
  "src/server/services/posts/view.ts",
  "src/components/targets/PerformancePanel.tsx",
];

describe("provider insights seam (FR-061, SC-013)", () => {
  it("names at least one provider key and one metric key (the scan itself works)", () => {
    expect(PROVIDER_KEYS.length).toBeGreaterThan(0);
    expect(METRIC_KEYS.length).toBeGreaterThan(0);
  });

  it("keeps every provider key and every platform metric key out of the generic insights modules", () => {
    for (const path of SEAM_MODULES) {
      const source = readFileSync(path, "utf8");
      for (const key of PROVIDER_KEYS) {
        expect(source.includes(`"${key}"`), `${path} must not mention the provider key ${key}`).toBe(false);
      }
      for (const key of METRIC_KEYS) {
        expect(source.includes(key), `${path} must not mention the platform metric key ${key}`).toBe(false);
      }
    }
  });

  // contracts/provider-insights-081.md §5, FR-034: three platforms label a metric "Views" and mean
  // three different events. Keys must stay provider-local — deliberately not a label-uniqueness check.
  it("declares disjoint post and account metric keys across Instagram, Facebook and Threads", () => {
    const byProvider = new Map(
      ["instagram", "facebook", "threads"].map((key) => {
        const provider = listProviders().find((p) => p.key === key)!;
        const keys = [...(provider.insights?.declaration.post ?? []), ...(provider.insights?.declaration.account ?? [])].map((m) => m.key);
        return [key, keys] as const;
      }),
    );
    const providerKeys = [...byProvider.keys()];
    for (let i = 0; i < providerKeys.length; i++) {
      for (let j = i + 1; j < providerKeys.length; j++) {
        const a = byProvider.get(providerKeys[i]!)!;
        const b = byProvider.get(providerKeys[j]!)!;
        const overlap = a.filter((k) => b.includes(k));
        expect(overlap, `${providerKeys[i]} and ${providerKeys[j]} must not share a declared metric key`).toEqual([]);
      }
    }
  });

  it("has no shared metric mapping table under src/providers/meta (each provider's declaration is its own)", () => {
    expect(() => readFileSync("src/providers/meta/metrics.ts", "utf8")).toThrow();
  });
});
