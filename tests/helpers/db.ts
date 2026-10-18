import { randomUUID } from "node:crypto";
import pg from "pg";
import { inject } from "vitest";
import { closeDb, createDatabase, getDb, type Database } from "../../src/server/db/client";
import { runMigrations } from "../../src/server/db/migrate";
import { adminUrl, createLabelledDatabase, poolTolerantOfDrops } from "../setup/test-databases";

/** The shared, migrated test database (same one the app code under test uses). */
export function testDb(): Database {
  return getDb();
}

export { closeDb };

/** A fresh, empty, migrated database for empty-install tests. Call `drop()` afterwards. */
export async function createThrowawayDb(): Promise<{
  url: string;
  db: Database;
  drop: () => Promise<void>;
}> {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("DATABASE_URL is required");
  const name = `docket_tmp_${randomUUID().replace(/-/g, "")}_test`;
  const adminPool = poolTolerantOfDrops(new pg.Pool({ connectionString: adminUrl(base), max: 1 }));
  // Labelled with this run, so global teardown drops it even when a test never calls drop().
  await createLabelledDatabase(adminPool, name, inject("testRunLabel"));

  const url = new URL(base);
  url.pathname = `/${name}`;
  await runMigrations(url.toString());
  const { db, pool } = createDatabase(url.toString(), 2);
  return {
    url: url.toString(),
    db,
    async drop() {
      await pool.end();
      await adminPool.query(`drop database if exists "${name}" with (force)`);
      await adminPool.end();
    },
  };
}

/**
 * Rethrows a drizzle failure with the Postgres fields drizzle keeps only in `cause`.
 *
 * Why this exists: `delete from "user"` in `security/secret-scan.test.ts` has been the suite's single
 * biggest flake — 11 of 20 repetitions in flake-hunt run 39088399743 and 10 of 20 in 39091454083 —
 * and across both runs not one of them recorded *why*. Drizzle throws
 * `Error: Failed query: delete from "user"` and puts the real Postgres error in `cause`, and nothing
 * in the pipeline carries it: vitest's JSON reporter serialises `failureMessages` (message plus
 * stack) and drops `cause`, and the lane stderr never sees it because `--reporter=json
 * --outputFile=` sends failures to the file rather than to stderr. So the one fact needed to fix it
 * was discarded twice, in two different places, by default.
 *
 * Folding the pg fields into the `message` is what makes them survive, because the message is the
 * part that gets serialised.
 *
 * `detail`, `hint` and the query parameters are deliberately omitted: those can echo row values, and
 * `secret-scan.test.ts` scans every line of captured output for secrets. `code`, `table`,
 * `constraint`, `severity` and `routine` are schema and classification facts, not data.
 */
export async function withDbCause<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const cause = ((error as { cause?: unknown }).cause ?? {}) as Record<string, unknown>;
    const fields = (["code", "severity", "table", "constraint", "routine"] as const)
      .flatMap((key) => (cause[key] ? [`${key}=${String(cause[key])}`] : []));
    throw new Error(
      `${label}: ${(error as Error)?.message ?? "unknown"} [${fields.join(" ") || "no pg cause attached"}]`,
      { cause: error },
    );
  }
}
