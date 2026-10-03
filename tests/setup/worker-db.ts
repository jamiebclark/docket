// Points this Vitest worker at its own clone of the migrated test database, so test
// files can run in parallel without sharing rows. Must be the FIRST setup file: it has
// to run before anything reads DATABASE_URL. The clones are made by global-setup.ts.
import { workerDatabaseUrl } from "./worker-databases";

const base = process.env.DATABASE_URL;
if (base && process.env.DOCKET_SKIP_DB_SETUP !== "1") {
  const url = workerDatabaseUrl(base, Number(process.env.VITEST_POOL_ID ?? "1"));
  process.env.DATABASE_URL = url;
  // Direct URL follows suit, so migration-aware code under test sees the same database.
  process.env.DATABASE_URL_DIRECT = url;
}
