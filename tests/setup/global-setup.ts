import pg from "pg";
import { runMigrations } from "../../src/server/db/migrate";
import { testWorkerCount, workerDatabaseUrl } from "./worker-databases";

function dbName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.slice(1));
}

/** Creates the test database if missing, then drops and recreates its schema and migrates. */
export default async function setup(): Promise<void> {
  // Explicit opt-out for unit-only runs where no database is reachable. Never set in CI.
  if (process.env.DOCKET_SKIP_DB_SETUP === "1") return;
  const url = process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL must point at a database whose name ends in _test.");
  }
  const name = dbName(url);
  if (!name.endsWith("_test")) {
    throw new Error(`Refusing to run tests against database "${name}": the name must end in _test.`);
  }

  const admin = new URL(url);
  admin.pathname = "/postgres";
  const adminPool = new pg.Pool({ connectionString: admin.toString(), max: 1 });
  try {
    const exists = await adminPool.query("select 1 from pg_database where datname = $1", [name]);
    if (exists.rowCount === 0) await adminPool.query(`create database "${name.replace(/"/g, '""')}"`);
  } finally {
    await adminPool.end();
  }

  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    await pool.query("drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;");
  } finally {
    await pool.end();
  }
  await runMigrations(url);

  // One clone per worker so test files run in parallel on separate databases.
  // CREATE DATABASE … TEMPLATE copies files, which is far faster than migrating each,
  // and needs no other session connected to the template — hence sequential, after
  // every pool on the base database has closed.
  const quote = (n: string) => `"${n.replace(/"/g, '""')}"`;
  const clonePool = new pg.Pool({ connectionString: admin.toString(), max: 1 });
  try {
    for (let id = 1; id <= testWorkerCount(); id++) {
      const clone = dbName(workerDatabaseUrl(url, id));
      await clonePool.query(`drop database if exists ${quote(clone)} with (force)`);
      await clonePool.query(`create database ${quote(clone)} template ${quote(name)}`);
    }
  } finally {
    await clonePool.end();
  }
}
