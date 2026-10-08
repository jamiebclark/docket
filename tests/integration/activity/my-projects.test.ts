import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createActivityRepo } from "../../../src/server/dal/activity";
import { forMyProjects } from "../../../src/server/dal/my-projects";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { member } from "../../../src/server/db/schema";
import { NotFoundError } from "../../../src/server/dal/errors";
import { listMyActivity } from "../../../src/server/services/activity";
import { atTime } from "../../helpers/clock";
import { closeDb, testDb } from "../../helpers/db";
import { addMember, createProject, createUser } from "../../helpers/factories";

afterAll(async () => {
  await closeDb();
});

const event = (message: string, occurredAt: Date) => ({
  kind: "target_published" as const,
  occurredAt,
  postId: randomUUID(),
  postTargetId: randomUUID(),
  socialAccountId: randomUUID(),
  providerKey: "bluesky",
  message,
  details: {},
});

async function setup(zones: { a?: string; b?: string; c?: string } = {}) {
  const [a, b, c] = await Promise.all([
    createProject({ name: "Alpha", timezone: zones.a }),
    createProject({ name: "Bravo", timezone: zones.b }),
    createProject({ name: "Charlie", timezone: zones.c }),
  ]);
  const me = await createUser();
  await addMember(a.id, me.id, "editor");
  await addMember(b.id, me.id, "owner");
  return { a, b, c, me, session: { user: { id: me.id } } };
}

const record = (projectId: string, message: string, at = new Date()) =>
  createActivityRepo(testDb(), projectId).insert(event(message, at));

describe("all-projects activity", () => {
  it("shows events of the caller's projects only, each row naming its project", async () => {
    const { a, b, c, session } = await setup();
    await record(a.id, "in A");
    await record(b.id, "in B");
    await record(c.id, "in C");
    const page = await listMyActivity(await forMyProjects(session), {});
    const byMessage = Object.fromEntries(page.rows.map((r) => [r.message, r.project.slug]));
    expect(byMessage).toEqual({ "in A": a.slug, "in B": b.slug });
    expect(page.summary.successes).toBe(2);
    expect(page.projects?.map((p) => p.slug).sort()).toEqual([a.slug, b.slug].sort());
  });

  it("filters by project slug, and a slug outside the caller's projects matches nothing", async () => {
    const { a, b, c, session } = await setup();
    await record(a.id, "in A");
    await record(b.id, "in B");
    await record(c.id, "in C");
    const set = await forMyProjects(session);
    expect((await listMyActivity(set, { project: a.slug })).rows.map((r) => r.message)).toEqual(["in A"]);
    const none = await listMyActivity(set, { project: c.slug });
    expect(none.rows).toEqual([]);
    expect(none.summary).toMatchObject({ successes: 0, problems: 0 });
  });

  it("drops a project the caller was removed from on the next call, including counts and a stored cursor", async () => {
    const { a, b, me, session } = await setup();
    for (let i = 0; i < 60; i++) {
      await record(i % 2 ? a.id : b.id, `Event ${i}`, new Date(Date.UTC(2020, 0, 1, 12, i)));
    }
    const first = await listMyActivity(await forMyProjects(session), {});
    expect(first.rows).toHaveLength(50);
    expect(first.older).not.toBeNull();

    await runCrossProject("test: remove member", () =>
      testDb().delete(member).where(and(eq(member.organizationId, b.id), eq(member.userId, me.id))),
    );
    const after = await listMyActivity(await forMyProjects(session), { cursor: first.older! });
    expect(after.rows.every((r) => r.project.slug === a.slug)).toBe(true);
    expect(after.summary.successes).toBe(30);
    expect((await listMyActivity(await forMyProjects(session), {})).rows.every((r) => r.project.slug === a.slug)).toBe(true);
  });

  it("hides a project removed between the membership read and the query", async () => {
    const { a, b, me, session } = await setup();
    await record(a.id, "in A");
    await record(b.id, "in B");
    const set = await forMyProjects(session);
    await runCrossProject("test: remove member", () =>
      testDb().delete(member).where(and(eq(member.organizationId, b.id), eq(member.userId, me.id))),
    );
    expect((await listMyActivity(set, {})).rows.map((r) => r.message)).toEqual(["in A"]);
  });

  it("is empty with no projects, and refuses without a session", async () => {
    const lonely = await createUser();
    const page = await listMyActivity(await forMyProjects({ user: { id: lonely.id } }), {});
    expect(page.rows).toEqual([]);
    expect(page.summary).toMatchObject({ successes: 0, problems: 0 });
    await expect(forMyProjects(null)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("counts each project's Today in its own time zone", async () => {
    const { a, b, session } = await setup({ a: "Pacific/Auckland", b: "America/Los_Angeles" });
    // 2026-03-10 23:30Z is Mar 11 12:30 in Auckland and Mar 10 16:30 in Los Angeles.
    await record(a.id, "A late", new Date("2026-03-10T20:00:00Z")); // Auckland Mar 11: today
    await record(a.id, "A early", new Date("2026-03-10T10:00:00Z")); // Auckland Mar 10 23:00: yesterday
    await record(b.id, "B late", new Date("2026-03-10T20:00:00Z")); // LA Mar 10: today
    await record(b.id, "B early", new Date("2026-03-10T10:00:00Z")); // LA Mar 10 03:00: today
    const page = await atTime(new Date("2026-03-10T23:30:00Z"), async () =>
      listMyActivity(await forMyProjects(session), { range: "today" }),
    );
    expect(page.rows.map((r) => r.message).sort()).toEqual(["A late", "B early", "B late"]);
    expect(page.summary.successes).toBe(3);
    expect(page.rows.find((r) => r.message === "A late")!.project.timeZone).toBe("Pacific/Auckland");
  });
});
