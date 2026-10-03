import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { queryObservers, type ObservedQuery } from "../../src/server/db/client";
import { runCrossProject } from "../../src/server/db/cross-project";
import { projectOwnedTables } from "../../src/server/db/project-owned";
import { member, projects } from "../../src/server/db/schema";
import { closeDb, testDb } from "../helpers/db";
import { createProjectWithMembers } from "../helpers/factories";
import { checkScope, type QueryRecord } from "../helpers/scope-check";
import { clearRecordedQueries } from "../setup/scope-recorder";

afterAll(async () => {
  await closeDb();
});

async function capture(fn: () => Promise<unknown>): Promise<QueryRecord[]> {
  const seen: QueryRecord[] = [];
  const obs = (q: ObservedQuery) =>
    seen.push({ sql: q.sql, params: q.params, ...(q.crossProjectReason ? { crossProjectReason: q.crossProjectReason } : {}) });
  queryObservers.add(obs);
  try {
    await fn();
  } finally {
    queryObservers.delete(obs);
  }
  return seen;
}

describe("scope check against the real client", () => {
  it("reports an unscoped select on member outside crossProject", async () => {
    const records = await capture(() => testDb().select().from(member));
    const { violations } = checkScope(records, projectOwnedTables);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/^Unscoped query on project-owned table "member"/);
    clearRecordedQueries(); // the afterEach hook would otherwise fail this test
  });

  it("passes a pinned query", async () => {
    const { project } = await createProjectWithMembers();
    const records = await capture(() => testDb().select().from(member).where(eq(member.organizationId, project.id)));
    const result = checkScope(records, projectOwnedTables);
    expect(result.violations).toEqual([]);
    expect(result.checked).toBeGreaterThan(0);
  });

  it("skips and counts a crossProject query", async () => {
    const records = await capture(() => runCrossProject("test: list all", async () => await testDb().select().from(member)));
    const result = checkScope(records, projectOwnedTables);
    expect(result.violations).toEqual([]);
    expect(result.crossProject.map((c) => c.reason)).toEqual(["test: list all"]);
  });

  it("covers a new table with one registry line", () => {
    const sql = 'select * from "widgets" where "widgets"."name" = $1';
    expect(checkScope([{ sql }], projectOwnedTables).violations).toEqual([]);
    const registry = [...projectOwnedTables, { table: "widgets", scopeColumn: "project_id" }];
    expect(checkScope([{ sql }], registry).violations).toHaveLength(1);
    expect(
      checkScope([{ sql: 'select * from "widgets" where "widgets"."project_id" = $1' }], registry).violations,
    ).toEqual([]);
  });

  it("keeps the projects registry entry pinned by id", async () => {
    const { project } = await createProjectWithMembers();
    const records = await capture(() => testDb().select().from(projects).where(eq(projects.id, project.id)));
    expect(checkScope(records, projectOwnedTables).violations).toEqual([]);
  });
});
