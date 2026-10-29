import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every `runTick` in a test pins `timeBudgetMs`.
 *
 * The tick's nine sections share one wall clock, and two of them stop claiming when too little of the
 * budget is left: generation needs `minCallMs + persistReserveMs` (11s) to remain, token refresh needs
 * `providerTimeoutMs` (10s). At the env defaults that is a ~14s window from the tick starting. A
 * four-core CI runner with three vitest workers on one Postgres closes it; a developer machine never
 * does. The section then claims nothing and the tick still reports success, so the test either waits
 * for work that never happens or asserts on a zero with nothing explaining it — passing locally and
 * failing only on CI.
 *
 * `SCHEDULER_TICK_BUDGET_SECONDS` cannot fix this from the environment: it is capped at 25. The budget
 * has to be pinned per call, which is what `tickConfig()` in `tests/helpers/jobs-env.ts` does.
 *
 * This test exists because pinning it in one call of a file and not the others is exactly the bug that
 * reached CI twice: `scheduler/refresh.test.ts` had the fix, with a comment explaining it, on one of
 * its six calls.
 *
 * It scans the helpers as well as the tests, because for a long time it did not, and six helpers
 * called `runTick({ config: {} })` behind the backs of about sixty test files. That is how a section
 * that could never start at the shipped budget — the insights poll, whose share was below one
 * provider timeout — stayed invisible: the only ticks running the real configuration were the ones
 * nothing was asserting about it, and every tick a test looked at closely had the budget pinned
 * wide open.
 */

const ROOT = process.cwd();

/** Either of these in a call's arguments guarantees a pinned budget. */
const PINNED = [/\btimeBudgetMs\b/, /\btickConfig\b/];

/**
 * Files whose subject IS the budget, so they pin their own (small) values deliberately and must not be
 * made generous. Each must still pin something — they are exempt from the helper, not from pinning.
 */
const OWNS_ITS_BUDGET = new Set([
  "tests/integration/jobs/budget.test.ts",
  // This file: the examples in its own prose are not calls.
  "tests/lint/tick-budget.test.ts",
  // Its sibling, for the same reason in reverse: tick-parking.test.ts has to contain the literal
  // string this lint searches for, because that string is its own detector.
  "tests/lint/tick-parking.test.ts",
]);

function testFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) testFiles(path, out);
    else if (/\.test\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

/** Every `.ts` under `tests/helpers`, test file or not: a helper's tick is some test's tick. */
function helperFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) helperFiles(path, out);
    else if (/\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

/** The text between the parentheses of each `runTick(` call, parens balanced. */
function callArguments(source: string): string[] {
  const out: string[] = [];
  const needle = "runTick(";
  for (let i = source.indexOf(needle); i !== -1; i = source.indexOf(needle, i + 1)) {
    // Skip `import { runTick }` and type positions: only a call has a paren we opened.
    let depth = 0;
    let j = i + needle.length - 1;
    for (; j < source.length; j++) {
      if (source[j] === "(") depth++;
      else if (source[j] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push(source.slice(i + needle.length, j));
  }
  return out;
}

describe("every runTick in a test or helper pins the tick budget", () => {
  const files = testFiles(join(ROOT, "tests")).concat(testFiles(join(ROOT, "src")), helperFiles(join(ROOT, "tests", "helpers")));

  it("finds the test files", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("has no unpinned runTick call", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = file.slice(ROOT.length + 1).replaceAll("\\", "/");
      if (OWNS_ITS_BUDGET.has(rel)) continue;
      const source = readFileSync(file, "utf8");
      if (!source.includes("runTick(")) continue;
      for (const args of callArguments(source)) {
        if (!PINNED.some((p) => p.test(args))) {
          offenders.push(`${rel}: runTick(${args.trim().slice(0, 60)})`);
        }
      }
    }
    expect(offenders, `pin timeBudgetMs (or use tickConfig()) in:\n${offenders.join("\n")}`).toEqual([]);
  });
});
