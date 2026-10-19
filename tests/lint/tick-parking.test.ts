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
 * It covers the section entry points as well as whole ticks, because the fix for the block-shaped
 * timeouts was to call one section instead of ten (#162, #167, #169, #170, #171, #173) - and a
 * section's claims are every bit as cross-project as a tick's. Checking only a whole tick would leave
 * the pattern this repo now prefers unguarded: a blind spot introduced by its own remedy.
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
  // Verified exempt rather than parked: its subject is that with no SMTP group configured the email
  // section does no work at all, and `runEmailDeliveries` returns on `if (!mailer)` before it claims
  // anything. Leftover rows cannot reach it, so parking would be noise in a test whose assertion is
  // that zero statements ran.
  "tests/integration/email/env-group.test.ts",
]);

/**
 * Known debt, listed rather than parked or hidden: 16 files under these two directories drive
 * `runStandingSeries` with nothing parked first.
 *
 * `parkAllStandingSeries()` already exists in tests/helpers/jobs-env.ts and **no test calls it** - it
 * is dead code waiting for exactly this. None of the 16 has appeared in any of the seven flake hunts,
 * so parking them all on suspicion would be sixteen untested edits with no measurement behind them,
 * and the one time today I changed a video test without the test actually running locally I shipped a
 * uuid type error to CI.
 *
 * So they are exempt for now and the gap is written down: a parker with no callers, and sixteen files
 * that could use it. That is a deliberate pass, not an oversight - it wants its own change with the
 * suite run behind it.
 */
const STANDING_SERIES_PENDING = ["tests/integration/standing-series/", "tests/integration/dated-series/"];

/**
 * A whole tick, and every section entry point a test can call instead of one.
 *
 * `runHousekeeping` and `runLoop` are deliberately absent: housekeeping prunes by age rather than
 * claiming due work, and no test drives the loop.
 */
const ENTRY_POINTS = [
  "runTick(",
  "runPublishing(",
  "runGenerationJobs(",
  "runTokenRefresh(",
  "runEmailDeliveries(",
  "runEngagementRead(",
  "runEngagementSend(",
  "runInsightsPoll(",
  "runStandingSeries(",
  "runWebhookDeliveries(",
];

function testFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) testFiles(path, out);
    else if (/\.test\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

describe("a test that runs a whole tick parks first", () => {
  it("has no file driving a tick or a section without parkAll", () => {
    const files = testFiles(join(ROOT, "tests"));
    const offenders: string[] = [];
    let runsTick = 0;
    for (const file of files) {
      const rel = file.slice(ROOT.length + 1).split("\\").join("/");
      const source = readFileSync(file, "utf8");
      if (!ENTRY_POINTS.some((e) => source.includes(e))) continue;
      runsTick++;
      if (RUNS_UNPARKED.has(rel)) continue;
      if (STANDING_SERIES_PENDING.some((dir) => rel.startsWith(dir))) continue;
      if (source.includes("parkAll")) continue;
      offenders.push(rel);
    }

    // Self-check: if the walk or the match broke, "no offenders" would look like a clean suite
    // forever. The two schema audits that missed a real bug twice today both failed exactly that way,
    // reporting an empty result from a matcher that matched nothing.
    expect(runsTick, "no file appears to drive a tick or a section, so this lint is not testing anything").toBeGreaterThan(20);

    expect(
      offenders,
      `these drive a tick or a section without parking leftover work first, so another file's rows can ` +
        `fill ` +
        `this tick's claims:\n  ${offenders.join("\n  ")}\n` +
        `Add \`beforeEach(parkAllDueTargets)\` (it covers due targets, engagement reads, insights polls ` +
        `and refresh accounts), or add the file to RUNS_UNPARKED with a reason.`,
    ).toEqual([]);
  });
});
