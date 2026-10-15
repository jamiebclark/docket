import { describe, expect, it } from "vitest";
import {
  mayAttemptReply,
  reserveFloor,
  stricterBudget,
  windowStart,
} from "../../../src/server/scheduler/engagement-budget";

describe("engagement-budget (research.md §8, FR-042, FR-043)", () => {
  it("reserveFloor floors count × (1 − reserve)", () => {
    expect(reserveFloor({ count: 1_666, windowSeconds: 3_600 }, 0.25)).toBe(1_249);
    expect(reserveFloor({ count: 10, windowSeconds: 3_600 }, 0.25)).toBe(7);
  });

  it("windowStart subtracts the budget's window", () => {
    const now = new Date("2026-01-01T01:00:00Z");
    expect(windowStart(now, { count: 10, windowSeconds: 3_600 })).toEqual(new Date("2026-01-01T00:00:00Z"));
  });

  it("stricterBudget picks the lower-rate limit", () => {
    const provider = { count: 1_666, windowSeconds: 3_600 };
    const stricterAccount = { count: 10, windowSeconds: 3_600 };
    expect(stricterBudget(provider, stricterAccount)).toEqual(stricterAccount);
    expect(stricterBudget(provider, { count: 10_000, windowSeconds: 3_600 })).toEqual(provider);
    expect(stricterBudget(provider, null)).toEqual(provider);
  });

  it("mayAttemptReply refuses once writes-in-window reach the reserve floor", () => {
    const budget = { count: 10, windowSeconds: 3_600 };
    const ok = mayAttemptReply({ budget, writesInWindow: 6, writeReserve: 0.25, sentThisRun: 0, sendsPerTick: 5 });
    expect(ok).toEqual({ ok: true });
    const blocked = mayAttemptReply({ budget, writesInWindow: 7, writeReserve: 0.25, sentThisRun: 0, sendsPerTick: 5 });
    expect(blocked).toEqual({ ok: false, reason: "write_allowance" });
  });

  it("mayAttemptReply refuses once the per-run cap is reached", () => {
    const budget = { count: 10_000, windowSeconds: 3_600 };
    const blocked = mayAttemptReply({ budget, writesInWindow: 0, writeReserve: 0.25, sentThisRun: 5, sendsPerTick: 5 });
    expect(blocked).toEqual({ ok: false, reason: "per_run_cap" });
  });

  it("on Bluesky's real numbers the reserve floor is far above normal use", () => {
    const budget = { count: 1_666, windowSeconds: 3_600 };
    expect(reserveFloor(budget, 0.25)).toBeGreaterThan(1_000);
  });
});
