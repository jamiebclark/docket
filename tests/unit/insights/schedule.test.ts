import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { nextAccountPollAt, nextPostPollAt } from "../../../src/lib/insights/schedule";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const T0 = new Date("2026-01-01T00:00:00.000Z");

function at(ms: number): Date {
  return new Date(T0.getTime() + ms);
}

describe("src/lib/insights/schedule.ts imports no clock and no database", () => {
  it("has no disallowed import", () => {
    const src = readFileSync("src/lib/insights/schedule.ts", "utf8");
    expect(src).not.toMatch(/from ["']\.\.\/\.\.\/server\//);
    expect(src).not.toMatch(/Date\.now\(\)/);
  });
});

describe("nextPostPollAt", () => {
  it("ages 30 min / 20 h / 3 d / 10 d / 40 d map to the documented interval", () => {
    const cases: [number, number | null][] = [
      [30 * 60_000, HOUR],
      [20 * HOUR, HOUR],
      [3 * DAY, DAY],
      [10 * DAY, 7 * DAY],
      [40 * DAY, null],
    ];
    for (const [age, interval] of cases) {
      const now = at(age);
      const got = nextPostPollAt({ publishedAt: T0, lastCapturedAt: now, now, minIntervalMs: 0 });
      if (interval === null) expect(got, `age ${age}`).toBeNull();
      else expect(got?.getTime(), `age ${age}`).toBe(now.getTime() + interval);
    }
  });

  it("holds at every band edge, one second before and one second after", () => {
    for (const edge of [24 * HOUR, 7 * DAY, 28 * DAY]) {
      for (const delta of [-1000, 0, 1000]) {
        const now = at(edge + delta);
        expect(() => nextPostPollAt({ publishedAt: T0, lastCapturedAt: now, now, minIntervalMs: 0 })).not.toThrow();
      }
    }
  });

  it("returns null for a candidate on or after publishedAt + 28d", () => {
    const now = at(27 * DAY + 23 * HOUR);
    const got = nextPostPollAt({ publishedAt: T0, lastCapturedAt: now, now, minIntervalMs: 0 });
    expect(got === null || got.getTime() < T0.getTime() + 28 * DAY).toBe(true);
  });

  it("age 40d with lastCapturedAt null is due now, then null after one capture", () => {
    const now = at(40 * DAY);
    const due = nextPostPollAt({ publishedAt: T0, lastCapturedAt: null, now, minIntervalMs: 0 });
    expect(due?.getTime()).toBe(now.getTime());
    const frozen = nextPostPollAt({ publishedAt: T0, lastCapturedAt: now, now, minIntervalMs: 0 });
    expect(frozen).toBeNull();
  });

  it("a frozen target returns null, never a far-future date", () => {
    const now = at(29 * DAY);
    const got = nextPostPollAt({ publishedAt: T0, lastCapturedAt: now, now, minIntervalMs: 0 });
    expect(got).toBeNull();
  });

  it("minIntervalMs floors the result", () => {
    const now = at(30 * 60_000);
    const got = nextPostPollAt({ publishedAt: T0, lastCapturedAt: now, now, minIntervalMs: 2 * HOUR });
    expect(got?.getTime()).toBe(now.getTime() + 2 * HOUR);
  });

  it("walks one target from publish to day 40 and captures exactly 32 times", () => {
    let lastCapturedAt: Date | null = null;
    let now = T0;
    let count = 0;
    let nextAt = nextPostPollAt({ publishedAt: T0, lastCapturedAt, now, minIntervalMs: 0 });
    while (nextAt !== null && nextAt.getTime() < T0.getTime() + 40 * DAY) {
      count++;
      lastCapturedAt = nextAt;
      now = nextAt;
      nextAt = nextPostPollAt({ publishedAt: T0, lastCapturedAt, now, minIntervalMs: 0 });
    }
    expect(count).toBe(32);
  });
});

describe("nextAccountPollAt", () => {
  it("never decays and never returns null", () => {
    let lastCapturedAt: Date | null = null;
    let now = T0;
    for (let i = 0; i < 10; i++) {
      const got = nextAccountPollAt({ lastCapturedAt, now, intervalMs: 6 * HOUR, minIntervalMs: 0 });
      expect(got).not.toBeNull();
      lastCapturedAt = got;
      now = got;
    }
  });

  it("floors on minIntervalMs", () => {
    const now = T0;
    const got = nextAccountPollAt({ lastCapturedAt: now, now, intervalMs: 1000, minIntervalMs: 6 * HOUR });
    expect(got.getTime()).toBe(now.getTime() + 6 * HOUR);
  });

  it("is due now when never captured", () => {
    const got = nextAccountPollAt({ lastCapturedAt: null, now: T0, intervalMs: 6 * HOUR, minIntervalMs: 0 });
    expect(got.getTime()).toBe(T0.getTime());
  });
});
