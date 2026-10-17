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
