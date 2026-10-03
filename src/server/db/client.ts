import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Logger } from "drizzle-orm/logger";
import { Pool } from "pg";
import { getEnv } from "../env";
import { currentCrossProjectReason } from "./cross-project";
import * as schema from "./schema";

export interface ObservedQuery {
  sql: string;
  params: readonly unknown[];
  crossProjectReason?: string;
}

/** Empty in production. The test harness registers a recorder (scope check). */
export const queryObservers = new Set<(query: ObservedQuery) => void>();

// Forwards to observers only; never prints SQL or parameters.
const logger: Logger = {
  logQuery(sql, params) {
    if (queryObservers.size === 0) return;
    const reason = currentCrossProjectReason();
    const query: ObservedQuery = { sql, params, ...(reason ? { crossProjectReason: reason } : {}) };
    for (const observer of queryObservers) observer(query);
  },
};

export type Database = NodePgDatabase<typeof schema>;

export function createDatabase(url: string, max = 10): { db: Database; pool: Pool } {
  const pool = new Pool({ connectionString: url, max });
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
