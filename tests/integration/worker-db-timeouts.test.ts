import { afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { getDb } from "../../src/server/db/client";
import { closeDb } from "../helpers/db";

afterAll(closeDb);

/**
 * Guards the server-side deadlines set in `tests/setup/worker-databases.ts`.
 *
 * Two things can go wrong with them, and only one is about the value:
 *
 * 1. They can be lost silently. They ride on the worker URL's `options` query string, so a URL
 *    rebuild that drops the query, an env validator that normalises it away, or a pool built from a
 *    different URL would all put the session back on the default of 0 — wait forever — with every
 *    test still green.
 * 2. They can be set too high to matter. This shipped at 30s against a `testTimeout` of 20s, so every
 *    default-timeout test died as "Test timed out in 20000ms" before Postgres cancelled anything, and
 *    the deadlines removed exactly none of the mystery they exist to remove.
 *    `generation/brand-context.test.ts` failed that way 2 of 20 repetitions with them already in
 *    place.
 *
 * So this asserts the relationship as well as the value: a deadline above the test timeout is dead
 * weight, and if someone lowers `testTimeout` this fails and says so.
 */
const SETTINGS = ["lock_timeout", "idle_in_transaction_session_timeout"] as const;

function configuredTestTimeoutMs(): number {
  const config = readFileSync("vitest.config.ts", "utf8");
  const m = config.match(/testTimeout:\s*([0-9_]+)/);
  expect(m, "vitest.config.ts no longer declares testTimeout; this guard needs updating").not.toBeNull();
  return Number(m![1]!.replace(/_/g, ""));
}

describe("worker database session deadlines", () => {
  it("applies both deadlines to the pool the tests actually use", async () => {
    for (const name of SETTINGS) {
      const r = await getDb().execute<{ setting: string }>(
        sql`select setting from pg_settings where name = ${name}`,
      );
      const ms = Number(r.rows[0]?.setting ?? "0");
      expect(ms, `${name} is 0 (wait forever) — the connection options were lost`).toBeGreaterThan(0);
    }
  });

  it("keeps lock_timeout below vitest's testTimeout, or it can never fire", async () => {
    const timeout = configuredTestTimeoutMs();
    const r = await getDb().execute<{ setting: string }>(
      sql`select setting from pg_settings where name = 'lock_timeout'`,
    );
    const ms = Number(r.rows[0]?.setting ?? "0");
    expect(
      ms,
      `lock_timeout is ${ms}ms but testTimeout is ${timeout}ms: the test dies first and Postgres never ` +
        `names the block, which is the whole point of setting it. Lower it below ${timeout}ms.`,
    ).toBeLessThan(timeout);
  });

  it("bounds the wait for a pool connection, which no server-side deadline can see", () => {
    // The third deadline, and the one the other two are blind to: `lock_timeout` and
    // `idle_in_transaction_session_timeout` only apply once a query reaches Postgres, and a client
    // queued for a pool connection has not reached it. pg defaults that wait to 0 - forever.
    //
    // Flake-hunt run 39195627319 is why this is here: it ran with `lock_timeout` at 15s, below the
    // 20s testTimeout, and produced zero "canceling statement due to lock timeout" across 80
    // repetitions while tests still died on bare 20s timeouts. Whatever those blocks are, they are
    // not row-lock waits.
    const ms = Number(process.env.DOCKET_POOL_CONNECT_TIMEOUT_MS ?? "0");
    expect(ms, "DOCKET_POOL_CONNECT_TIMEOUT_MS is unset, so a pool wait hangs instead of failing").toBeGreaterThan(0);
    expect(ms, "a pool wait must fail before the test timeout, or the test is blamed instead of the pool").toBeLessThan(
      configuredTestTimeoutMs(),
    );
  });

  it("leaves idle_in_transaction_session_timeout above it, because it catches a different thing", async () => {
    // Deliberately NOT below testTimeout. This one kills a session idle inside a transaction, which is
    // a leak that would otherwise hang forever, so a generous value still catches it. Setting it to
    // 15s broke jobs/fairness.test.ts with 25P03 - that test holds a transaction across a 20-item job,
    // and killing it is a false positive. Asserted so nobody "fixes" it down to match lock_timeout.
    const timeout = configuredTestTimeoutMs();
    const r = await getDb().execute<{ setting: string }>(
      sql`select setting from pg_settings where name = 'idle_in_transaction_session_timeout'`,
    );
    const ms = Number(r.rows[0]?.setting ?? "0");
    expect(ms, "idle_in_transaction_session_timeout must stay set").toBeGreaterThan(timeout);
  });
});
