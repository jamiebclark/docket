import { describe, expect, it } from "vitest";
import type { AccountMetricsReadContext, PostMetricsReadContext } from "../types";
import { threadsInsights } from "./insights";
import type { ThreadsSettings } from "./settings";

const now = new Date("2026-01-01T12:00:00Z");

const postCtx: PostMetricsReadContext<ThreadsSettings> = {
  account: { id: "a1", externalId: "17800000000000000", displayName: "Threads", settings: {}, credentials: {} },
  posts: [{ externalId: "18000000000000000" }],
  now,
  signal: new AbortController().signal,
};

const accountCtx: AccountMetricsReadContext<ThreadsSettings> = {
  account: { id: "a1", externalId: "17800000000000000", displayName: "Threads", settings: {}, credentials: {} },
  now,
  signal: new AbortController().signal,
};

describe("threadsInsights declaration", () => {
  it("declares unavailable, with no post or account metrics (research §3: enum not CONFIRMED)", () => {
    expect(threadsInsights.declaration.post).toEqual([]);
    expect(threadsInsights.declaration.account).toEqual([]);
    expect(threadsInsights.declaration.unavailable).toEqual({
      reason: "Docket has not confirmed which metrics the Threads insights API reports.",
      docsPath: "insights",
    });
  });

  it("never declares `shares` (research §3, R3: not corroborated)", () => {
    const keys = [...threadsInsights.declaration.post, ...threadsInsights.declaration.account].map((m) => m.key);
    expect(keys).not.toContain("shares");
  });

  it("declares no requiredScopes (mutually exclusive with unavailable, per the registry assertion)", () => {
    expect(threadsInsights.declaration.requiredScopes).toBeUndefined();
  });
});

describe("threadsInsights reads", () => {
  it("readPostMetrics returns `unavailable` without making a call", async () => {
    const r = await threadsInsights.readPostMetrics(postCtx);
    expect(r).toEqual({
      kind: "unavailable",
      reason: "Docket has not confirmed which metrics the Threads insights API reports.",
      docsPath: "insights",
    });
  });

  it("readAccountMetrics returns `unavailable` without making a call", async () => {
    const r = await threadsInsights.readAccountMetrics(accountCtx);
    expect(r).toEqual({
      kind: "unavailable",
      reason: "Docket has not confirmed which metrics the Threads insights API reports.",
      docsPath: "insights",
    });
  });
});
