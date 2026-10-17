// Empties every table before each test, by default, with no cooperation from the test author
// (contracts/test-harness.md). Registered in vitest.config.ts's setupFiles, right after
// worker-db.ts so DATABASE_URL already points at this worker's clone, and before
// scope-recorder.ts so its own queries are never observed.
//
// Uses its own pg.Pool, never getDb(): that keeps it invisible to scope-recorder.ts and
// unaffected by the closeDb() calls scattered across the suite's afterAll hooks (research.md R2).
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { databaseName } from "./test-databases";
import { resetStatements } from "./table-reset";

let shareState = false;
let pool: Pool | undefined;
let tableNames: string[] | undefined;

/**
 * Switches this file from per-test reset to per-file reset. Call at module top level, before any
 * `describe`. Idempotent; takes effect for the whole file however late in the module body it is
 * called, because the flag is only read once the file's `beforeAll`/`beforeEach` run.
 */
export function shareStateWithinFile(): void {
  shareState = true;
}

function requirePool(): Pool {
  if (pool) return pool;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set before tests/setup/reset-database.ts runs");
  const name = databaseName(url);
  if (!name.endsWith("_test")) {
    throw new Error(`Refusing to reset database "${name}": the name must end in _test.`);
  }
  pool = new Pool({ connectionString: url, max: 1 });
  return pool;
}

async function loadTableNames(pool: Pool): Promise<string[]> {
  if (tableNames) return tableNames;
  const { rows } = await pool.query<{ table_name: string }>(
    `select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`,
  );
  tableNames = rows.map((r) => r.table_name);
  return tableNames;
}

/** Empties the worker's database now. For a test that must reset mid-case; rarely needed. */
export async function resetDatabaseNow(): Promise<void> {
  if (process.env.DOCKET_SKIP_DB_SETUP === "1") return;
  const pool = requirePool();
  const tables = await loadTableNames(pool);
  const statements = resetStatements(tables);
  // BEGIN/COMMIT must run on the same connection, so check one out rather than using
  // pool.query() (which may hand each call a different client from the pool).
  const client = await pool.connect();
  try {
    await client.query("begin");
    try {
      await client.query("set local session_replication_role = replica");
      await client.query(statements);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  if (shareState) await resetDatabaseNow();
});

beforeEach(async () => {
  if (!shareState) await resetDatabaseNow();
});

afterAll(async () => {
  await pool?.end();
  pool = undefined;
  tableNames = undefined;
});
