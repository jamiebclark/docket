// Points this Vitest worker at its own clone of this run's migrated test database, so test
// files can run in parallel without sharing rows. Must be the FIRST setup file: it has
// to run before anything reads DATABASE_URL. The clones are made by global-setup.ts.
import { inject } from "vitest";
import { workerDatabaseUrl } from "./worker-databases";

const base = process.env.DOCKET_SKIP_DB_SETUP === "1" ? undefined : inject("testDatabaseUrl");
if (base) {
  const url = workerDatabaseUrl(base, Number(process.env.VITEST_POOL_ID ?? "1"));
  process.env.DATABASE_URL = url;
  // Direct URL follows suit, so migration-aware code under test sees the same database.
  process.env.DATABASE_URL_DIRECT = url;
  // Name a pool wait instead of hanging on it. Server-side deadlines cannot see this one: a client
  // queued for a connection has not reached Postgres, so neither `lock_timeout` nor
  // `idle_in_transaction_session_timeout` applies. 10s is below vitest's 20s `testTimeout`, so the
  // failure says "timeout exceeded when trying to connect" rather than surfacing as whichever test
  // happened to be waiting. Left unset in production.
  process.env.DOCKET_POOL_CONNECT_TIMEOUT_MS ??= "10000";
}
