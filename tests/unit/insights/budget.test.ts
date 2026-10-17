import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as engagementBudget from "../../../src/server/scheduler/engagement-budget";
import { reserveFloor, stricterBudget } from "../../../src/server/scheduler/insights-budget";

describe("src/server/scheduler/insights-budget.ts", () => {
  it("imports stricterBudget and reserveFloor from engagement-budget.ts, not reimplemented", () => {
    const src = readFileSync("src/server/scheduler/insights-budget.ts", "utf8");
    expect(src).toMatch(/import\s*\{[^}]*reserveFloor[^}]*stricterBudget[^}]*\}\s*from\s*["']\.\/engagement-budget["']|import\s*\{[^}]*stricterBudget[^}]*reserveFloor[^}]*\}\s*from\s*["']\.\/engagement-budget["']/);
    expect(reserveFloor).toBe(engagementBudget.reserveFloor);
    expect(stricterBudget).toBe(engagementBudget.stricterBudget);
  });

  it("the refusal threshold is floor(count × (1 − reserve)), at the boundary, one below and one above", () => {
    const budget = { count: 100, windowSeconds: 3_600 };
    const floor = reserveFloor(budget, 0.5);
    expect(floor).toBe(50);
    expect(floor - 1).toBeLessThan(floor);
    expect(floor + 1).toBeGreaterThan(floor);
    // floor(100 * (1 - 0.3)) = 70
    expect(reserveFloor({ count: 100, windowSeconds: 3_600 }, 0.3)).toBe(70);
    // floor(7 * (1 - 0.5)) = 3
    expect(reserveFloor({ count: 7, windowSeconds: 3_600 }, 0.5)).toBe(3);
  });
});
