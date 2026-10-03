import { AsyncLocalStorage } from "node:async_hooks";

// Lives in the db layer so the query logger can read it; the DAL re-exports `crossProject`.
const storage = new AsyncLocalStorage<{ reason: string }>();

export function currentCrossProjectReason(): string | undefined {
  return storage.getStore()?.reason;
}

/** Runs `fn` with queries marked as deliberately not pinned to one project. */
export function runCrossProject<T>(reason: string, fn: () => Promise<T>): Promise<T> {
  return storage.run({ reason }, fn);
}
