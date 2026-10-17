import { describe, expect, it } from "vitest";
import { buildTargetInsightsView, type BuildTargetInsightsViewInput } from "../../../src/lib/insights/panel";
import type { InsightsDeclaration } from "../../../src/providers/types";

const NOW = new Date("2026-01-01T00:00:00Z");

const DECLARATION: InsightsDeclaration = {
  post: [
    { key: "likeCount", label: "Likes" },
    { key: "quoteCount", label: "Quotes" },
  ],
  account: [{ key: "followersCount", label: "Followers" }],
  maxPostsPerRead: 25,
  readBudget: { count: 100, windowSeconds: 3600 },
};

const BASE: BuildTargetInsightsViewInput = {
  status: "published",
  externalId: "ext-1",
  declaration: DECLARATION,
  providerName: "Bluesky",
  snapshot: null,
  pollState: null,
  now: NOW,
};

describe("buildTargetInsightsView (contracts/panel.md §2)", () => {
  it("row 1: an unpublished target has no panel at all", () => {
    expect(buildTargetInsightsView({ ...BASE, status: "scheduled" })).toEqual({ state: "not_published" });
    expect(buildTargetInsightsView({ ...BASE, status: "draft" })).toEqual({ state: "not_published" });
  });

  it("row 2: a provider with no insights member is unsupported", () => {
    expect(buildTargetInsightsView({ ...BASE, declaration: null })).toEqual({ state: "platform_unsupported", providerName: "Bluesky" });
  });

  it("row 3: a declared-unavailable surface shows the reason and docs link", () => {
    const declaration: InsightsDeclaration = { ...DECLARATION, unavailable: { reason: "Needs a permission Docket does not hold.", docsPath: "limits" } };
    expect(buildTargetInsightsView({ ...BASE, declaration })).toEqual({
      state: "unavailable",
      reason: "Needs a permission Docket does not hold.",
      docsPath: "limits",
    });
  });

  it("row 4: a hand-published target with no external id has no post to read numbers from", () => {
    expect(buildTargetInsightsView({ ...BASE, externalId: null })).toEqual({ state: "no_external_id" });
  });

  it("row 5: gone wins over failing even with failures recorded", () => {
    const pollState = { nextPollAt: null, consecutiveFailures: 3, failingSince: NOW, lastError: "boom", frozenReason: "gone" };
    expect(buildTargetInsightsView({ ...BASE, pollState })).toEqual({ state: "gone", snapshot: null });
  });

  it("row 5: gone with a surviving snapshot carries its rows", () => {
    const pollState = { nextPollAt: null, consecutiveFailures: 0, failingSince: null, lastError: null, frozenReason: "gone" };
    const snapshot = { capturedAt: NOW, metrics: { likeCount: 4 } };
    expect(buildTargetInsightsView({ ...BASE, pollState, snapshot })).toEqual({
      state: "gone",
      snapshot: { capturedAt: NOW, rows: [{ label: "Likes", value: 4 }] },
    });
  });

  it("row 6: failing with no earlier snapshot", () => {
    const since = new Date("2025-12-01T00:00:00Z");
    const pollState = { nextPollAt: null, consecutiveFailures: 1, failingSince: since, lastError: "Reads have been failing.", frozenReason: null };
    expect(buildTargetInsightsView({ ...BASE, pollState })).toEqual({
      state: "failing",
      since,
      reason: "Reads have been failing.",
      snapshot: null,
    });
  });

  it("row 6: failing carries the last good snapshot too", () => {
    const since = new Date("2025-12-01T00:00:00Z");
    const pollState = { nextPollAt: null, consecutiveFailures: 4, failingSince: since, lastError: "boom", frozenReason: null };
    const snapshot = { capturedAt: NOW, metrics: { likeCount: 2 } };
    expect(buildTargetInsightsView({ ...BASE, pollState, snapshot })).toEqual({
      state: "failing",
      since,
      reason: "boom",
      snapshot: { capturedAt: NOW, rows: [{ label: "Likes", value: 2 }] },
    });
  });

  it("row 7: no snapshot and no failure is not polled yet, carrying the due time", () => {
    const pollState = { nextPollAt: new Date("2026-01-02T00:00:00Z"), consecutiveFailures: 0, failingSince: null, lastError: null, frozenReason: null };
    expect(buildTargetInsightsView({ ...BASE, pollState })).toEqual({ state: "not_polled_yet", firstReadDueAt: pollState.nextPollAt });
  });

  it("row 7: no poll state at all still renders not_polled_yet with a null due time", () => {
    expect(buildTargetInsightsView({ ...BASE, pollState: null })).toEqual({ state: "not_polled_yet", firstReadDueAt: null });
  });

  it("row 8: a snapshot with no declared key present reports nothing", () => {
    const snapshot = { capturedAt: NOW, metrics: { somethingElse: 9 } };
    expect(buildTargetInsightsView({ ...BASE, snapshot })).toEqual({ state: "nothing_reported", capturedAt: NOW });
  });

  it("row 9: a snapshot with declared keys present is reported, in declaration order, absent keys produce no row", () => {
    const snapshot = { capturedAt: NOW, metrics: { likeCount: 4 } };
    expect(buildTargetInsightsView({ ...BASE, snapshot })).toEqual({
      state: "reported",
      capturedAt: NOW,
      rows: [{ label: "Likes", value: 4 }],
    });
  });

  it("no output path produces a delta, a total or a second value", () => {
    const snapshot = { capturedAt: NOW, metrics: { likeCount: 4, quoteCount: 1 } };
    const view = buildTargetInsightsView({ ...BASE, snapshot });
    expect(view).toEqual({
      state: "reported",
      capturedAt: NOW,
      rows: [
        { label: "Likes", value: 4 },
        { label: "Quotes", value: 1 },
      ],
    });
    expect(JSON.stringify(view)).not.toMatch(/delta|total|percent/i);
  });
});
