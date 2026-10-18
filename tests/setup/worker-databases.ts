import { availableParallelism } from "node:os";

/** How many Vitest workers (and therefore database clones) a run uses. */
export function testWorkerCount(): number {
  const fromEnv = Number(process.env.DOCKET_TEST_WORKERS);
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;
  return Math.max(1, Math.min(4, availableParallelism() - 1));
}

/** `…/docket_test` → `…/docket_w3_test`: keeps the `_test` suffix the safety check needs. */
export function workerDatabaseUrl(baseUrl: string, workerId: number): string {
  const url = new URL(baseUrl);
  const name = decodeURIComponent(url.pathname.slice(1));
  url.pathname = `/${name.replace(/_test$/, "")}_w${workerId}_test`;
  // Server-side deadlines, so a block becomes a named Postgres error instead of a mystery.
  //
  // Both default to 0 (wait forever), and that is how a whole class of CI flakes stayed unexplained:
  // a query waiting on a lock, or a transaction left open by unawaited work, simply blocks until
  // something else gives up first, and whatever gives up first is what gets blamed.
  // `jobs/posting-instructions.test.ts` runs in 390 ms locally and has died on a 60 s test timeout;
  // `scheduler/refresh.test.ts` loses its account to the refresh section's silent `outOfBudget` path
  // when a tick cannot finish inside 120 s. Neither failure named a lock, because nothing was
  // looking for one.
  //
  // 30 s is far above any legitimate statement here (the suite's own tests are milliseconds, and the
  // slowest deliberate stall is a 6 s fake LLM call in jobs/budget.test.ts) and far below the 60 s
  // test timeout, so a real block now fails as "canceling statement due to lock timeout" or
  // "terminating connection due to idle-in-transaction timeout" — with the blocked query named —
  // rather than as a timeout somewhere downstream.
  //
  // Tests that exercise lock contention on purpose set `SET LOCAL lock_timeout` inside their own
  // transaction (see dal/notifications.ts), which takes precedence over this.
  url.searchParams.set("options", "-c lock_timeout=30s -c idle_in_transaction_session_timeout=30s");
  return url.toString();
}
