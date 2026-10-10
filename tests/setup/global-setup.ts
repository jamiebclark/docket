import pg from "pg";
import type { TestProject } from "vitest/node";
import { runMigrations } from "../../src/server/db/migrate";
import {
  adminUrl,
  createLabelledDatabase,
  databaseName,
  dropRun,
  newRunId,
  runDatabaseName,
  runLabel,
  sweep,
  withDatabase,
  poolTolerantOfDrops,
  type RunLabel,
} from "./test-databases";
import { testWorkerCount, workerDatabaseUrl } from "./worker-databases";

declare module "vitest" {
  export interface ProvidedContext {
    /** This run's migrated base database; worker-db.ts points each worker at its clone. */
    testDatabaseUrl: string;
    /** Label for databases created during the run (throwaways), so teardown and sweeps find them. */
    testRunLabel: RunLabel;
  }
}

/**
 * Gives this run its own databases (see test-databases.ts): sweeps databases left by dead runs,
 * creates and migrates `<prefix>_<checkout>_<id>_test`, clones it once per worker, and returns a
 * teardown that drops everything labelled with this run. `KEEP_TEST_DB=1` keeps them for debugging.
 */
export default async function setup(project: TestProject): Promise<(() => Promise<void>) | void> {
  // Explicit opt-out for unit-only runs where no database is reachable. Never set in CI.
  if (process.env.DOCKET_SKIP_DB_SETUP === "1") return;
  const configured = process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL;
  if (!configured) {
    throw new Error("DATABASE_URL must point at a database whose name ends in _test.");
  }
  const configuredName = databaseName(configured);
  if (!configuredName.endsWith("_test")) {
    throw new Error(`Refusing to run tests against database "${configuredName}": the name must end in _test.`);
  }

  const runId = newRunId();
  const label = runLabel(runId);
  const base = runDatabaseName(configuredName, process.cwd(), runId);
  const baseUrl = withDatabase(configured, base);

  const admin = poolTolerantOfDrops(new pg.Pool({ connectionString: adminUrl(configured), max: 1 }));
  try {
    const swept = await sweep(admin, {});
    if (swept.length > 0) console.log(`test databases: dropped ${swept.length} left by finished runs (${swept.map((s) => s.name).join(", ")})`);
    await createLabelledDatabase(admin, base, label);
  } finally {
    await admin.end();
  }
  await runMigrations(baseUrl);

  // One clone per worker so test files run in parallel on separate databases.
  // CREATE DATABASE … TEMPLATE copies files, which is far faster than migrating each,
  // and needs no other session connected to the template — hence sequential, after
  // every pool on the base database has closed.
  const cloner = poolTolerantOfDrops(new pg.Pool({ connectionString: adminUrl(configured), max: 1 }));
  try {
    for (let id = 1; id <= testWorkerCount(); id++) {
      await createLabelledDatabase(cloner, databaseName(workerDatabaseUrl(baseUrl, id)), label, base);
    }
  } finally {
    await cloner.end();
  }

  project.provide("testDatabaseUrl", baseUrl);
  project.provide("testRunLabel", label);

  return async () => {
    if (process.env.KEEP_TEST_DB === "1") {
      console.log(`test databases kept (KEEP_TEST_DB=1): ${base} and its _w<n> clones; run "pnpm db:test:clean" when done`);
      return;
    }
    const pool = poolTolerantOfDrops(new pg.Pool({ connectionString: adminUrl(configured), max: 1 }));
    try {
      await dropRun(pool, runId);
    } finally {
      await pool.end();
    }
  };
}
