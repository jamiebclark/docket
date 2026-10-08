import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { forProject } from "../../../src/server/dal";
import { ForbiddenError } from "../../../src/server/dal/errors";
import { listProjectActivity } from "../../../src/server/services/activity";
import { encodeActivityCursor } from "../../../src/server/services/activity/cursor";
import { closeDb } from "../../helpers/db";
import { createProject, createUser, addMember } from "../../helpers/factories";

afterAll(async () => {
  await closeDb();
});

const session = (id: string) => ({ user: { id } });
const at = (min: number) => new Date(Date.UTC(2020, 0, 1, 12, min));

async function seeded(count: number) {
  const project = await createProject();
  const owner = await createUser();
  await addMember(project.id, owner.id, "owner");
  const scope = await forProject(session(owner.id), project.slug);
  const account = randomUUID();
  for (let i = 0; i < count; i++) {
    await scope.activity.insert({
      kind: i % 3 === 0 ? "target_failed" : "target_published",
      occurredAt: at(i),
      postId: randomUUID(),
      postTargetId: randomUUID(),
      socialAccountId: account,
      providerKey: "bluesky",
      message: `Event ${i}`,
      details: i % 3 === 0 ? { attempt: 1 } : {},
    });
  }
  return { scope, owner, project };
}

describe("listProjectActivity", () => {
  it("returns newest first with counts, deleted-account and post labels, and pages through 50 at a time", async () => {
    const { scope } = await seeded(60);
    const first = await listProjectActivity(scope, {});
    expect(first.rows).toHaveLength(50);
    expect(first.rows[0]!.message).toBe("Event 59");
    expect(first.summary).toMatchObject({ successes: 40, problems: 20, label: "All time" });
    expect(first.rows[0]!.account).toMatchObject({ name: "Removed account", removed: true });
    expect(first.rows[0]!.post).toMatchObject({ deleted: true });
    expect(first.rows[0]!.actorLabel).toBe("Scheduler");
    expect(first.newer).toBeNull();
    expect(first.older).not.toBeNull();

    const second = await listProjectActivity(scope, { cursor: first.older! });
    expect(second.rows.map((r) => r.message)).toEqual(Array.from({ length: 10 }, (_, i) => `Event ${9 - i}`));
    expect(second.older).toBeNull();
    expect(second.newer).not.toBeNull();

    const back = await listProjectActivity(scope, { cursor: second.newer! });
    expect(back.rows).toHaveLength(50);
    expect(back.rows[0]!.message).toBe("Event 59");
    expect(back.newer).toBeNull();
  });

  it("filters, ignores a malformed cursor and reports an inverted range", async () => {
    const { scope } = await seeded(6);
    const problems = await listProjectActivity(scope, { outcome: "problems" });
    expect(problems.rows).toHaveLength(2);
    expect(problems.summary.successes).toBe(4); // counts ignore only the outcome part
    expect((await listProjectActivity(scope, { cursor: "garbage" })).rows).toHaveLength(6);
    const bad = await listProjectActivity(scope, { from: "2026-10-07", to: "2026-10-01" });
    expect(bad).toMatchObject({ invalidRange: true, rows: [], summary: { successes: 0, problems: 0 } });
    // A cursor past the newest event falls back to the first page.
    const beyond = encodeActivityCursor({ t: "2030-01-01T00:00:00.000Z", s: "99999999", d: "newer" });
    expect((await listProjectActivity(scope, { cursor: beyond })).rows).toHaveLength(6);
  });

  it("refuses a viewer without post:view and never shows another project's events", async () => {
    const { scope } = await seeded(2);
    const other = await seeded(3);
    expect((await listProjectActivity(other.scope, {})).rows).toHaveLength(3);
    expect((await listProjectActivity(scope, {})).rows).toHaveLength(2);
    const denied = { ...scope, can: () => false } as typeof scope;
    await expect(listProjectActivity(denied, {})).rejects.toBeInstanceOf(ForbiddenError);
  });
});
