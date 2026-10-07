import { describe, expect, it } from "vitest";
import type { RetryAllPreview, RetryAllResult } from "@/server/services/posts";
import {
  UNEXPECTED_ERROR,
  canConfirmAll,
  confirmAllLabel,
  controlRemains,
  previewLines,
  retryAllLabel,
  retryAllTitle,
  summaryAccounts,
} from "./retry-all-ui";

const zero = { account_removed: 0, needs_reconnecting: 0, provider_unavailable: 0, no_longer_failed: 0, cannot_publish: 0, no_free_slot: 0 };

function preview(p: Partial<RetryAllPreview> = {}): RetryAllPreview {
  return {
    scope: null,
    inScope: 5,
    blocked: { account_removed: 0, needs_reconnecting: 0, provider_unavailable: 0 },
    eligible: 5,
    willAttempt: 5,
    cap: 100,
    capApplies: false,
    ...p,
  };
}

function result(r: Partial<RetryAllResult> = {}): RetryAllResult {
  return { changed: true, message: "m", count: 1, mode: "now", inScope: 1, skipped: { ...zero }, remaining: 0, accounts: [], ...r };
}

describe("labels", () => {
  it.each([
    [4, "Acme Bluesky", "Retry all 4 failed posts for Acme Bluesky"],
    [1, "Acme Bluesky", "Retry 1 failed post for Acme Bluesky"],
    [12, null, "Retry all 12 failed posts"],
    [1, null, "Retry 1 failed post"],
  ])("retryAllLabel %#", (n, name, expected) => expect(retryAllLabel(n, name)).toBe(expected));

  it("retryAllTitle", () => {
    expect(retryAllTitle("Acme Bluesky")).toBe("Retry all failed posts for Acme Bluesky");
    expect(retryAllTitle(null)).toBe("Retry all failed posts");
  });

  it("confirmAllLabel", () => {
    expect(confirmAllLabel("now")).toBe("Retry now");
    expect(confirmAllLabel("requeue")).toBe("Requeue posts");
  });
});

describe("previewLines", () => {
  it("plain counts", () => {
    expect(previewLines(preview())).toEqual({ counts: ["5 failed posts across all accounts.", "5 will be retried."], blocked: [] });
  });
  it("scoped, singular", () => {
    const p = preview({ scope: { accountId: "a", accountName: "Acme" }, inScope: 1, willAttempt: 1 });
    expect(previewLines(p).counts[0]).toBe("1 failed post in Acme.");
  });
  it("cap note", () => {
    const p = preview({ inScope: 130, willAttempt: 100, capApplies: true });
    expect(previewLines(p).counts[1]).toBe("Up to 100 will be retried in this step; press again to continue.");
  });
  it("blocked lines", () => {
    const p = preview({ blocked: { account_removed: 0, needs_reconnecting: 2, provider_unavailable: 0 }, willAttempt: 3 });
    expect(previewLines(p)).toEqual({
      counts: ["5 failed posts across all accounts.", "3 will be retried.", "2 can't be retried yet:"],
      blocked: ["2 need reconnecting"],
    });
  });
});

describe("canConfirmAll", () => {
  it("is false while loading or empty, true when something can be attempted", () => {
    expect(canConfirmAll("loading")).toBe(false);
    expect(canConfirmAll(null)).toBe(false);
    expect(canConfirmAll(preview({ willAttempt: 0 }))).toBe(false);
    expect(canConfirmAll(preview())).toBe(true);
  });
});

describe("controlRemains", () => {
  it("ignores no_longer_failed", () => {
    expect(controlRemains(result({ skipped: { ...zero, no_longer_failed: 3 } }))).toBe(false);
  });
  it("counts remaining and other skips", () => {
    expect(controlRemains(result({ remaining: 5 }))).toBe(true);
    expect(controlRemains(result({ skipped: { ...zero, no_free_slot: 1 } }))).toBe(true);
  });
});

describe("summaryAccounts", () => {
  const row = (name: string, retried: number, skipped = {}, remaining = 0) => ({ accountId: name, name, retried, skipped: { ...zero, ...skipped }, remaining });
  it("is empty when at most one account has skips", () => {
    expect(summaryAccounts(result({ accounts: [row("A", 2), row("B", 1, { needs_reconnecting: 1 })] }))).toEqual([]);
  });
  it("lists accounts with a skip or remaining when more than one", () => {
    const r = result({ accounts: [row("A", 2, { needs_reconnecting: 2 }), row("B", 1), row("C", 0, {}, 4)] });
    expect(summaryAccounts(r)).toEqual([
      { name: "A", line: "A: 2 retried, 2 need reconnecting" },
      { name: "C", line: "C: 0 retried, 4 not retried yet" },
    ]);
  });
});

it("UNEXPECTED_ERROR", () => expect(UNEXPECTED_ERROR).toContain("Reload the page"));
