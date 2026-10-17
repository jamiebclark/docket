import type { SchedulerConfig } from "../../src/server/scheduler/config";

/**
 * The tick budget every test should run with, and the only reason tests need to think about it.
 *
 * `runTick` runs nine sections concurrently against one wall clock, and two of them stop claiming when
 * too little of the budget is left: generation needs `minCallMs + persistReserveMs` (11s) to remain
 * (`scheduler/generation.ts`), token refresh needs `providerTimeoutMs` (10s)
 * (`scheduler/token-refresh.ts`). At the environment defaults that leaves roughly a 14s window from the
 * tick starting. A developer machine never closes it; a four-core CI runner with three vitest workers
 * sharing one Postgres does. The section then claims nothing and the tick still reports success, so a
 * test either waits for work that never happens or asserts on a zero with nothing explaining it —
 * green locally, red only on CI.
 *
 * `SCHEDULER_TICK_BUDGET_SECONDS` cannot raise it: the env var is capped at 25. So the budget is pinned
 * per call, and `tests/lint/tick-budget.test.ts` fails the build on a call that forgets.
 *
 * None of this is what the tests are about, which is the point of pinning it once here.
 */
export const TICK_BUDGET_MS = 120_000;

/**
 * Tick options with the budget pinned. `over` is spread last, so a test that genuinely cares about a
 * different budget can still pass its own.
 */
export const tickConfig = (over: Partial<SchedulerConfig> = {}) => ({
  config: { timeBudgetMs: TICK_BUDGET_MS, ...over },
});

/** The nine section names on a `TickSummary`, for `runTick({ only })`. */
export type SectionName =
  | "publishing"
  | "tokenRefresh"
  | "generation"
  | "housekeeping"
  | "webhooks"
  | "email"
  | "standingSeries"
  | "engagementRead"
  | "engagementSend";

export const SECTIONS: readonly SectionName[] = [
  "publishing",
  "tokenRefresh",
  "generation",
  "housekeeping",
  "webhooks",
  "email",
  "standingSeries",
  "engagementRead",
  "engagementSend",
];

/**
 * Drives ticks until `until` holds, then returns. Replaces a fixed-count loop (FR-017): a loop bounded
 * by a literal count passes or fails depending on how much capacity the machine drains per tick, which
 * is exactly the thing a test must not depend on.
 *
 * `ceiling` is headroom, not an expectation: it exists so a wedged test fails rather than hangs, and it
 * must be generously above the ticks the work needs. On reaching it, throws naming what had not
 * drained and the accumulated per-disposition tally (FR-029), so the failure says what did not finish
 * rather than that a number was wrong.
 */
export async function drainTicks<T>(opts: {
  tick: (n: number) => Promise<T>;
  until: (result: T, n: number) => boolean;
  ceiling: number;
  describe: (n: number) => string;
}): Promise<{ ticks: number; results: T[] }> {
  const results: T[] = [];
  for (let n = 1; n <= opts.ceiling; n++) {
    const result = await opts.tick(n);
    results.push(result);
    if (opts.until(result, n)) return { ticks: n, results };
  }
  const tally = results
    .map((result, i) => `  tick ${i + 1}: ${JSON.stringify(result)}`)
    .join("\n");
  throw new Error(`drainTicks: never satisfied "${opts.describe(opts.ceiling)}" within ${opts.ceiling} ticks\n${tally}`);
}
