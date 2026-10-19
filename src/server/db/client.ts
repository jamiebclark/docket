import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Logger } from "drizzle-orm/logger";
import { Pool } from "pg";
import { getEnv } from "../env";
import { currentCrossProjectReason, currentProjectSet, type ProjectSet } from "./cross-project";
import * as schema from "./schema";

export interface ObservedQuery {
  sql: string;
  params: readonly unknown[];
  crossProjectReason?: string;
  projectSet?: ProjectSet;
}

/** Empty in production. The test harness registers a recorder (scope check). */
export const queryObservers = new Set<(query: ObservedQuery) => void>();

// Forwards to observers only; never prints SQL or parameters.
const logger: Logger = {
  logQuery(sql, params) {
    if (queryObservers.size === 0) return;
    const reason = currentCrossProjectReason();
    const projectSet = currentProjectSet();
    const query: ObservedQuery = {
      sql,
      params,
      ...(reason ? { crossProjectReason: reason } : {}),
      ...(projectSet ? { projectSet } : {}),
    };
    for (const observer of queryObservers) observer(query);
  },
};

export type Database = NodePgDatabase<typeof schema>;

export function createDatabase(url: string, max = 10): { db: Database; pool: Pool } {
  // `connectionTimeoutMillis` defaults to 0 - wait forever for a pool client - and that wait is
  // invisible to every server-side deadline, because `lock_timeout` and
  // `idle_in_transaction_session_timeout` only apply once a query reaches Postgres. A client queued
  // for a connection has not reached it.
  //
  // That gap is why a whole class of CI failures stayed unexplained. Flake-hunt run 39195627319 ran
  // with `lock_timeout` at 15s, below vitest's 20s `testTimeout`, and produced ZERO
  // "canceling statement due to lock timeout" across 80 repetitions while
  // `generation/brand-context.test.ts` still died on a bare 20s timeout - so those blocks
  // are not waiting on row locks. A pool wait is the remaining candidate the deadlines cannot see:
  // `runTick` runs ten sections concurrently, `DATABASE_POOL_MAX` defaults to ten, and `clock.now()`
  // takes a second connection unless handed a transaction (see the warning in dal/clock.ts).
  //
  // Unset in production, so behaviour there is unchanged: a request keeps waiting as it does today.
  // The test harness sets it, so a pool wait fails as "timeout exceeded when trying to connect"
  // instead of hanging until some unrelated test timeout fires. This is a diagnostic, not a theory
  // being asserted - `jobs/posting-instructions.test.ts` passes 3/3 at DATABASE_POOL_MAX=3, which
  // argues against pool starvation, so the next hunt gets to decide rather than me.
  const connectTimeout = Number(process.env.DOCKET_POOL_CONNECT_TIMEOUT_MS ?? "0");
  const pool = new Pool({
    connectionString: url,
    max,
    ...(Number.isFinite(connectTimeout) && connectTimeout > 0 ? { connectionTimeoutMillis: connectTimeout } : {}),
  });
  // An idle client that loses its connection (database restart, forced drop) emits
  // "error" on the pool; unhandled, that crashes the process. The pool discards the
  // client and reconnects on the next query, so log the code (never the URL) and go on.
  pool.on("error", (err: Error & { code?: string }) => {
    console.error(`Docket: idle database connection lost${err.code ? ` (${err.code})` : ""}`);
  });
  return { db: drizzle(pool, { schema, logger }), pool };
}

let shared: { db: Database; pool: Pool } | undefined;

/** Lazy so importing this module (e.g. during `next build`) needs no secrets. */
export function getDb(): Database {
  if (!shared) {
    const env = getEnv();
    shared = createDatabase(env.DATABASE_URL, env.DATABASE_POOL_MAX);
  }
  return shared.db;
}

export async function closeDb(): Promise<void> {
  const current = shared;
  shared = undefined;
  await current?.pool.end();
}
