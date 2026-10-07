import { describe, expect, it } from "vitest";
import { milestonesCrossed, percentOf } from "./milestones";

describe("milestonesCrossed", () => {
  it("reports each milestone once while progress climbs, at most five in all", () => {
    let seen = -1;
    const out: number[] = [];
    for (let pct = 0; pct <= 100; pct++) {
      out.push(...milestonesCrossed(seen, pct));
      seen = Math.max(seen, pct);
    }
    expect(out).toEqual([0, 25, 50, 75, 100]);
  });

  it("announces nothing again after a retry resumes lower", () => {
    expect(milestonesCrossed(60, 40)).toEqual([]);
    expect(milestonesCrossed(60, 60)).toEqual([]);
    expect(milestonesCrossed(60, 80)).toEqual([75]);
  });

  it("reports several milestones passed in one step", () => {
    expect(milestonesCrossed(10, 100)).toEqual([25, 50, 75, 100]);
  });
});

describe("percentOf", () => {
  it("floors and never exceeds 100", () => {
    expect(percentOf(1, 3)).toBe(33);
    expect(percentOf(5, 5)).toBe(100);
    expect(percentOf(9, 3)).toBe(100);
    expect(percentOf(1, 0)).toBe(0);
  });
});
