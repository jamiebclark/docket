import { AsyncLocalStorage } from "node:async_hooks";

// Lives in the db layer so the query logger can read it; the DAL re-exports `crossProject`.
const storage = new AsyncLocalStorage<{ reason: string }>();

export interface ProjectSet {
  reason: string;
  projectIds: readonly string[];
}

// A second section: statements pinned to project ids, each of which must be one of `projectIds` (scope harness).
const projectSetStorage = new AsyncLocalStorage<ProjectSet>();

export function currentCrossProjectReason(): string | undefined {
  return storage.getStore()?.reason;
}

/** Runs `fn` with queries marked as deliberately not pinned to one project. */
export function runCrossProject<T>(reason: string, fn: () => Promise<T>): Promise<T> {
  return storage.run({ reason }, fn);
}

export function currentProjectSet(): ProjectSet | undefined {
  return projectSetStorage.getStore();
}

/** Runs `fn` with queries marked as pinned to the given project set; the test harness checks every pin is in it. */
export function runForProjectSet<T>(set: ProjectSet, fn: () => Promise<T>): Promise<T> {
  return projectSetStorage.run({ reason: set.reason, projectIds: [...set.projectIds] }, fn);
}
