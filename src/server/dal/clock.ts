import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "drizzle-orm";
import { getDb } from "../db/client";
import type { Database } from "../db/client";

// One clock for the whole engine: the database's (FR-040). Tests pin it with `runAtTime`.
const override = new AsyncLocalStorage<{ at: Date }>();

/** Current time. Production reads the database clock; inside `runAtTime` it is the fixed date. */
export async function now(exec?: Database): Promise<Date> {
  const pinned = override.getStore();
  if (pinned) return new Date(pinned.at);
  // Inside a transaction, pass its handle: a second pooled connection would starve under concurrency.
  const result = await (exec ?? getDb()).execute<{ t: Date | string }>(sql`select clock_timestamp() as t`);
  return new Date(result.rows[0]!.t);
}

/** Runs `fn` with `now()` fixed at `date`. For tests. */
export function runAtTime<T>(date: Date, fn: () => Promise<T>): Promise<T> {
  return override.run({ at: new Date(date) }, fn);
}
