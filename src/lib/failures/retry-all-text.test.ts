import { describe, expect, it } from "vitest";
import {
  SKIP_REASONS,
  retryAllMessage,
  skipPhrase,
  type RetryAllSkipReason,
  type SkipCounts,
} from "./retry-all-text";

function skips(partial: Partial<SkipCounts> = {}): SkipCounts {
  return {
    account_removed: 0,
    needs_reconnecting: 0,
    provider_unavailable: 0,
    no_longer_failed: 0,
    cannot_publish: 0,
    no_free_slot: 0,
    ...partial,
  };
}

const base = { mode: "now" as const, inScope: 5, count: 1, skipped: skips(), remaining: 0 };

describe("retryAllMessage", () => {
  it.each([
    [{ ...base, inScope: 0, count: 0 }, "There are no failed posts to retry."],
    [base, "1 post will be retried."],
    [
      { ...base, count: 10, skipped: skips({ needs_reconnecting: 2 }) },
      "10 posts will be retried. Skipped 2: 2 need reconnecting.",
    ],
    [{ ...base, mode: "requeue" as const }, "1 post was queued into the next free slot."],
    [
      {
        ...base,
        mode: "requeue" as const,
        count: 4,
        skipped: skips({ no_free_slot: 1, cannot_publish: 1 }),
      },
      "4 posts were queued into the next free slots. Skipped 2: 1 can't be published as is, 1 no free slot.",
    ],
    [
      { ...base, count: 0, skipped: skips({ needs_reconnecting: 2, no_free_slot: 1 }) },
      "No posts were retried. Skipped 3: 2 need reconnecting, 1 no free slot.",
    ],
    [
      { ...base, count: 100, remaining: 130 },
      "100 posts will be retried. 130 more failed posts were not retried yet. Press Retry all failed again to continue.",
    ],
    [
      { ...base, count: 100, remaining: 1 },
      "100 posts will be retried. 1 more failed post was not retried yet. Press Retry all failed again to continue.",
    ],
  ])("renders %#", (input, expected) => {
    expect(retryAllMessage(input)).toBe(expected);
  });

  it("lists reasons in D3 order regardless of key order", () => {
    const message = retryAllMessage({
      ...base,
      skipped: skips({
        no_free_slot: 1,
        cannot_publish: 1,
        no_longer_failed: 1,
        provider_unavailable: 1,
        needs_reconnecting: 1,
        account_removed: 1,
      }),
    });
    expect(message).toBe(
      "1 post will be retried. Skipped 6: 1 on a removed account, 1 needs reconnecting, 1 with an unavailable provider, 1 no longer failed, 1 can't be published as is, 1 no free slot.",
    );
  });
});

describe("skipPhrase", () => {
  const table: Record<RetryAllSkipReason, [string, string]> = {
    account_removed: ["1 on a removed account", "3 on removed accounts"],
    needs_reconnecting: ["1 needs reconnecting", "3 need reconnecting"],
    provider_unavailable: ["1 with an unavailable provider", "3 with an unavailable provider"],
    no_longer_failed: ["1 no longer failed", "3 no longer failed"],
    cannot_publish: ["1 can't be published as is", "3 can't be published as is"],
    no_free_slot: ["1 no free slot", "3 no free slot"],
  };

  it.each(SKIP_REASONS)("singular and plural for %s", (reason) => {
    expect(skipPhrase(reason, 1)).toBe(table[reason][0]);
    expect(skipPhrase(reason, 3)).toBe(table[reason][1]);
  });
});
