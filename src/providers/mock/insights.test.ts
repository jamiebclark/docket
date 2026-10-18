import { describe, expect, it } from "vitest";
import { mockInsights } from "./insights";
import { mockInsightsReadBehaviours, mockSettingsSchema } from "./settings";

const account = (settings: Record<string, unknown>) => ({
  account: { id: "a1", externalId: "ext1", displayName: "Account", settings: mockSettingsSchema.parse(settings), credentials: {} },
  now: new Date(),
  signal: new AbortController().signal,
});

describe("mock insights fixture", () => {
  it("is unavailable, never calling through, when insightsUnavailable is set", async () => {
    const ctx = account({ insightsUnavailable: true });
    const post = await mockInsights.readPostMetrics({ ...ctx, posts: [{ externalId: "p1" }] });
    expect(post.kind).toBe("unavailable");
    const acct = await mockInsights.readAccountMetrics(ctx);
    expect(acct.kind).toBe("unavailable");
  });

  it("reaches every stop kind from insightsPostReadBehaviour and insightsAccountReadBehaviour", async () => {
    for (const behaviour of mockInsightsReadBehaviours) {
      if (behaviour === "page") continue;
      const post = await mockInsights.readPostMetrics({ ...account({ insightsPostReadBehaviour: behaviour }), posts: [{ externalId: "p1" }] });
      expect(post.kind, behaviour).toBe(behaviour);
      const acct = await mockInsights.readAccountMetrics(account({ insightsAccountReadBehaviour: behaviour }));
      expect(acct.kind, behaviour).toBe(behaviour);
    }
  });

  it("returns gone for a scripted gone external id, metrics for the rest", async () => {
    const ctx = account({ insightsGoneExternalIds: ["p2"] });
    const result = await mockInsights.readPostMetrics({ ...ctx, posts: [{ externalId: "p1" }, { externalId: "p2" }] });
    expect(result.kind).toBe("page");
    if (result.kind !== "page") throw new Error("unreachable");
    expect(result.entries.find((e) => e.externalId === "p1")?.kind).toBe("metrics");
    expect(result.entries.find((e) => e.externalId === "p2")?.kind).toBe("gone");
  });

  it("returns an undeclared key when insightsReturnUndeclaredKey is set", async () => {
    const ctx = account({ insightsReturnUndeclaredKey: true });
    const result = await mockInsights.readPostMetrics({ ...ctx, posts: [{ externalId: "p1" }] });
    expect(result.kind).toBe("page");
    if (result.kind !== "page") throw new Error("unreachable");
    const entry = result.entries[0];
    expect(entry?.kind === "metrics" && (entry.metrics as Record<string, unknown>).notDeclared).toBe(1);
  });

  it("returns an oversized payload when insightsOversizedPayload is set", async () => {
    const ctx = account({ insightsOversizedPayload: true });
    const result = await mockInsights.readPostMetrics({ ...ctx, posts: [{ externalId: "p1" }] });
    expect(result.kind).toBe("page");
    if (result.kind !== "page") throw new Error("unreachable");
    const entry = result.entries[0];
    const metrics = entry?.kind === "metrics" ? entry.metrics : null;
    expect(JSON.stringify(metrics).length).toBeGreaterThan(2000);

    const acctResult = await mockInsights.readAccountMetrics(account({ insightsOversizedPayload: true }));
    expect(acctResult.kind).toBe("page");
    if (acctResult.kind !== "page") throw new Error("unreachable");
    expect(JSON.stringify(acctResult.metrics).length).toBeGreaterThan(2000);
  });

  it("declares maxPostsPerRead: 3 and the mock-only viewCount key", () => {
    expect(mockInsights.declaration.maxPostsPerRead).toBe(3);
    expect(mockInsights.declaration.post.map((k) => k.key)).toContain("viewCount");
  });
});
