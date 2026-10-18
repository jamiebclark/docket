import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { getDb } from "../../src/server/db/client";
import { closeDb } from "../helpers/db";

afterAll(closeDb);

/**
 * Guards the server-side deadlines set in `tests/setup/worker-databases.ts`.
 *
 * They are attached as connection `options` on the worker's DATABASE_URL, which means they can be
 * lost without anything failing: a URL rebuild that drops the query string, an env validator that
 * normalises it away, or a pool constructed from a different URL would all leave the session back on
 * the default of 0 — wait forever — and every test would still pass. The whole value of those
 * deadlines is that a block fails fast and names itself, so losing them silently puts the suite back
 * to blaming whichever unrelated test happens to time out first.
 */
describe("worker database session deadlines", () => {
  it("applies lock_timeout and idle_in_transaction_session_timeout to the pool the tests use", async () => {
    const [lock, idle] = await Promise.all([
      getDb().execute<{ setting: string }>(sql`select setting from pg_settings where name = 'lock_timeout'`),
      getDb().execute<{ setting: string }>(
        sql`select setting from pg_settings where name = 'idle_in_transaction_session_timeout'`,
      ),
    ]);
    // pg_settings reports these in milliseconds.
    expect(lock.rows[0]?.setting, "lock_timeout on the worker database").toBe("30000");
    expect(idle.rows[0]?.setting, "idle_in_transaction_session_timeout on the worker database").toBe("30000");
  });
});
