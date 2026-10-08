import { afterEach, beforeEach } from "vitest";
import { queryObservers, type ObservedQuery } from "../../src/server/db/client";
import { projectOwnedTables } from "../../src/server/db/project-owned";
import { checkScope, type QueryRecord } from "../helpers/scope-check";

let records: QueryRecord[] = [];
let checked = 0;
const crossProject = new Map<string, number>();
const projectSets = new Map<string, number>();

const observer = (q: ObservedQuery) => {
  records.push({
    sql: q.sql,
    params: q.params,
    ...(q.crossProjectReason ? { crossProjectReason: q.crossProjectReason } : {}),
    ...(q.projectSet ? { projectSet: q.projectSet } : {}),
  });
};

queryObservers.add(observer);

/** For tests that issue a deliberately unscoped query: drop what was recorded so far. */
export function clearRecordedQueries(): void {
  records = [];
}

beforeEach(() => {
  records = [];
});

afterEach(() => {
  const result = checkScope(records, projectOwnedTables);
  checked += result.checked;
  for (const c of result.crossProject) crossProject.set(c.reason, (crossProject.get(c.reason) ?? 0) + 1);
  for (const c of result.projectSet) projectSets.set(c.reason, (projectSets.get(c.reason) ?? 0) + 1);
  // A test that issues a deliberately unscoped query opts out by clearing `records` itself.
  if (result.violations.length > 0) {
    throw new Error(result.violations.join("\n\n"));
  }
});

// Vitest runs this file per test file; print a one-line summary when the worker finishes.
process.on("beforeExit", () => {
  if (checked === 0 && crossProject.size === 0 && projectSets.size === 0) return;
  const reasons = [...crossProject].map(([r, n]) => `${r} x${n}`).join(", ");
  const sets = [...projectSets].map(([r, n]) => `${r} x${n}`).join(", ");
  console.info(
    `[scope-check] ${checked} project-scoped queries checked; cross-project: ${reasons || "none"}; project-set: ${sets || "none"}`,
  );
});
