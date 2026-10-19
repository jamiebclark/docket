import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every test that runs a whole tick parks leftover scheduler work first.
 *
 * A tick's claims are cross-project and `limit`-bounded, so rows left behind by other files on the
 * same worker database are claimed by the tick under test. The symptoms are not obviously about
 * leftovers: `insights/no-reconnect-safety.test.ts` asserted zero HTTP requests and saw 1 then 2 as
 * the shuffled file order changed, and `pinterest/availability.test.ts` found no poll-state row at all
 * because the claim never reached its target. Both read as a broken assertion rather than a crowded
 * database.
 *
 * This is a lint rather than a sweep because the sweep went stale in a day. #157 audited every file
 * that ran a tick without parking, found four, and fixed them; `pinterest/availability.test.ts` was
 * added afterwards with the same gap and flaked in the next hunt. A one-off audit cannot hold a line
 * that new files keep crossing.
 */

const ROOT = process.cwd();

/**
 * Files that run a tick deliberately against whatever is there.
 *
 * Add one only with a reason: "it was failing" is not one, because parking is nearly always the fix.
 */
const RUNS_UNPARKED = new Set<string>([
  // These two: `runTick(` appears as prose, or as the string this lint's sibling searches for, not as
  // a call. `tick-budget.test.ts` exempts itself from its own rule for exactly the same reason.
  "tests/lint/tick-parking.test.ts",
  "tests/lint/tick-budget.test.ts",
]);

function testFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) testFiles(path, out);
    else if (/\.test\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

describe("a test that runs a whole tick parks first", () => {
  it("has no file calling runTick without parkAll", () => {
    const files = testFiles(join(ROOT, "tests"));
    const offenders: string[] = [];
    let runsTick = 0;
    for (const file of files) {
      const rel = file.slice(ROOT.length + 1).split("\\").join("/");
      const source = readFileSync(file, "utf8");
      if (!source.includes("runTick(")) continue;
      runsTick++;
      if (RUNS_UNPARKED.has(rel)) continue;
      if (source.includes("parkAll")) continue;
      offenders.push(rel);
    }

    // Self-check: if the walk or the match broke, "no offenders" would look like a clean suite
    // forever. The two schema audits that missed a real bug twice today both failed exactly that way,
    // reporting an empty result from a matcher that matched nothing.
    expect(runsTick, "no file appears to call runTick at all, so this lint is not testing anything").toBeGreaterThan(20);

    expect(
      offenders,
      `these run a whole tick without parking leftover work first, so another file's rows can fill ` +
        `this tick's claims:\n  ${offenders.join("\n  ")}\n` +
        `Add \`beforeEach(parkAllDueTargets)\` (it covers due targets, engagement reads, insights polls ` +
        `and refresh accounts), or add the file to RUNS_UNPARKED with a reason.`,
    ).toEqual([]);
  });
});
