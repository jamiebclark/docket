import { afterAll, describe, expect, it } from "vitest";
import { queryObservers, type ObservedQuery } from "../../../src/server/db/client";
import { NotFoundError } from "../../../src/server/dal/errors";
import { forMyProjects } from "../../../src/server/dal/my-projects";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { member } from "../../../src/server/db/schema";
import { and, eq } from "drizzle-orm";
import { testDb, closeDb } from "../../helpers/db";
import { addMember, createProject, createUser } from "../../helpers/factories";
import { checkScope, type QueryRecord } from "../../helpers/scope-check";
import { projectOwnedTables } from "../../../src/server/db/project-owned";
import { recordEvent, startReading } from "../../helpers/notifications";

afterAll(async () => {
  await closeDb();
});

async function capture(fn: () => Promise<unknown>): Promise<QueryRecord[]> {
  const seen: QueryRecord[] = [];
  const obs = (q: ObservedQuery) =>
    seen.push({ sql: q.sql, params: q.params, ...(q.crossProjectReason ? { crossProjectReason: q.crossProjectReason } : {}), ...(q.projectSet ? { projectSet: q.projectSet } : {}) });
  queryObservers.add(obs);
  try {
    await fn();
  } finally {
    queryObservers.delete(obs);
  }
  return seen;
}

async function setup() {
  const [a, b, other] = await Promise.all([createProject(), createProject(), createProject()]);
  const u = await createUser();
  await addMember(a.id, u.id);
  await addMember(b.id, u.id);
  await startReading(a.id, u.id);
  await startReading(b.id, u.id);
  await recordEvent(a.id, "target_failed");
  return { a, b, other, u };
}

describe("notification statements and the project set", () => {
  it("runs count, recent and unread-projects inside the project-set section with pins in the caller's set", async () => {
    const { a, b, u } = await setup();
    const set = await forMyProjects({ user: { id: u.id } });
    const records = await capture(async () => {
      await set.notifications.countUnread();
      await set.notifications.recent(10);
      await set.notifications.projectsWithUnread();
    });
    expect(records.length).toBeGreaterThan(0);
    for (const r of records) {
      expect([...(r.projectSet?.projectIds ?? [])].sort()).toEqual([a.id, b.id].sort());
    }
    const result = checkScope(records, projectOwnedTables);
    expect(result.violations).toEqual([]);
    expect(result.projectSet.length).toBeGreaterThan(0);
  });

  it("pins a per-project write to its project, and a foreign id throws before any SQL", async () => {
    const { a, other, u } = await setup();
    const set = await forMyProjects({ user: { id: u.id } });
    const ok = await capture(() => set.notifications.write(a.id, { markRead: true }));
    expect(checkScope(ok, projectOwnedTables).violations).toEqual([]);
    const foreign = await capture(async () => {
      await expect(set.notifications.write(other.id, { markRead: true })).rejects.toBeInstanceOf(NotFoundError);
    });
    expect(foreign).toEqual([]);
  });

  it("excludes a project whose member row is removed between resolving and counting", async () => {
    const { b, u } = await setup();
    await recordEvent(b.id, "target_failed");
    const set = await forMyProjects({ user: { id: u.id } });
    expect(await set.notifications.countUnread()).toBe(2);
    await runCrossProject("test: remove member", () =>
      testDb().delete(member).where(and(eq(member.organizationId, b.id), eq(member.userId, u.id))),
    );
    expect(await set.notifications.countUnread()).toBe(1);
  });
});
