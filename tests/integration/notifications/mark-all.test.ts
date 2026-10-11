import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);
vi.mock("next/cache", async () => (await import("../../helpers/actions")).cacheModule);
vi.mock("next/navigation", async () => (await import("../../helpers/actions")).navigationModule);

import { markAllRead } from "../../../src/app/notifications/actions";
import { forMyProjects } from "../../../src/server/dal/my-projects";
import { setNotificationsAfterLockHookForTests, setNotificationsLockTimeoutForTests } from "../../../src/server/dal/notifications";
import { markAllRead as markAllReadService, setSwitchBySlug, unreadSummary } from "../../../src/server/services/notifications";
import { actAs, RedirectSignal } from "../../helpers/actions";
import { closeDb } from "../../helpers/db";
import { addMember, createProject, createUser } from "../../helpers/factories";
import { markEventFor, marksFor, recordEvent, startReading } from "../../helpers/notifications";

afterAll(async () => {
  actAs(null);
  await closeDb();
});

const count = async (userId: string) => (await unreadSummary(await forMyProjects({ user: { id: userId } }))).count;

async function fixture() {
  const [a, b] = await Promise.all([createProject({ name: "Alpha" }), createProject({ name: "Bravo" })]);
  const u = await createUser();
  for (const p of [a, b]) {
    await addMember(p.id, u.id, "editor");
    await startReading(p.id, u.id);
  }
  return { a, b, u };
}

const form = (entries: Record<string, string> = {}) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
};

describe("markAllRead action", () => {
  it("marks every project and returns the new count when there is no returnTo", async () => {
    const { a, b, u } = await fixture();
    await recordEvent(a.id, "target_failed");
    await recordEvent(b.id, "target_ambiguous");
    actAs(u);
    const result = await markAllRead(null, form());
    expect(result).toEqual({
      ok: true,
      data: { unread: { count: 0, display: "", label: "No unread problems", nextChangeAt: null }, busy: [], snoozesCleared: 0 },
    });
    expect(await count(u.id)).toBe(0);
  });

  it("marks a project that's off's backlog too, so turning it back on later shows nothing old", async () => {
    const { a, b, u } = await fixture();
    await setSwitchBySlug(await forMyProjects({ user: { id: u.id } }), { projectSlug: b.slug, axis: "project", on: "false" });
    await recordEvent(a.id, "target_failed");
    await recordEvent(b.id, "target_failed");
    actAs(u);
    await markAllRead(null, form());
    await setSwitchBySlug(await forMyProjects({ user: { id: u.id } }), { projectSlug: b.slug, axis: "project", on: "true" });
    expect(await count(u.id)).toBe(0);
  });

  it("redirects back to /notifications with marked=1 when returnTo says so", async () => {
    const { a, u } = await fixture();
    await recordEvent(a.id, "target_failed");
    actAs(u);
    const error = await markAllRead(null, form({ returnTo: "/notifications" })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RedirectSignal);
    expect((error as RedirectSignal).to).toBe("/notifications?marked=1");
    expect(await count(u.id)).toBe(0);
  });

  it.each(["https://evil.example/", "//evil.example", "/p/acme", "/notifications?x=1", ""])("ignores returnTo=%j and returns a result", async (returnTo) => {
    const { u } = await fixture();
    actAs(u);
    const result = await markAllRead(null, form({ returnTo }));
    expect(result.ok).toBe(true);
  });

  it("reports a busy project and still redirects with busy named", async () => {
    const { a, u } = await fixture();
    await recordEvent(a.id, "target_failed");
    setNotificationsLockTimeoutForTests(150);
    setNotificationsAfterLockHookForTests(null);
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    await client.query("begin");
    await client.query("select id from projects where id = $1 for update", [a.id]);
    try {
      actAs(u);
      const result = await markAllRead(null, form());
      expect(result).toEqual({
        ok: true,
        data: { unread: { count: 1, display: "1", label: "1 unread problem", nextChangeAt: null }, busy: ["Alpha"], snoozesCleared: 0 },
      });
      const error = await markAllRead(null, form({ returnTo: "/notifications" })).catch((e: unknown) => e);
      expect((error as RedirectSignal).to).toBe("/notifications?marked=1&busy=Alpha");
    } finally {
      await client.query("commit");
      await client.end();
      setNotificationsLockTimeoutForTests(2000);
    }
  });

  it("sends a signed-out caller to /login", async () => {
    actAs(null);
    const error = await markAllRead(null, form()).catch((e: unknown) => e);
    expect((error as RedirectSignal).to).toBe("/login?next=/notifications");
  });
});

describe("markAllRead (service): floor move plus prune (US3)", () => {
  it("raises the floor over individually-read and snoozed events and prunes every mark for the project, reporting snoozesCleared", async () => {
    const { a, u } = await fixture();
    const readEvent = await recordEvent(a.id, "target_failed");
    const snoozedEvent = await recordEvent(a.id, "target_ambiguous");
    await recordEvent(a.id, "account_needs_reauth");
    await markEventFor(a.id, u.id, readEvent.id);
    await markEventFor(a.id, u.id, snoozedEvent.id, new Date(Date.now() + 60 * 60 * 1000));
    expect(await count(u.id)).toBe(1);
    actAs(u);
    const result = await markAllReadService(await forMyProjects({ user: { id: u.id } }));
    expect(result).toEqual({ marked: 1, busy: [], snoozesCleared: 1 });
    expect(await marksFor(a.id, u.id)).toEqual([]);
    expect(await count(u.id)).toBe(0);
  });

  it("does not bring a cleared snooze back", async () => {
    const { a, u } = await fixture();
    const snoozedEvent = await recordEvent(a.id, "target_ambiguous");
    await markEventFor(a.id, u.id, snoozedEvent.id, new Date(Date.now() + 60 * 60 * 1000));
    actAs(u);
    await markAllReadService(await forMyProjects({ user: { id: u.id } }));
    expect(await count(u.id)).toBe(0);
    expect(await marksFor(a.id, u.id)).toEqual([]);
  });

  it("an event committed a moment after the mark-all began still counts as unread", async () => {
    const { a, u } = await fixture();
    await recordEvent(a.id, "target_failed");
    actAs(u);
    await markAllReadService(await forMyProjects({ user: { id: u.id } }));
    expect(await count(u.id)).toBe(0);
    await recordEvent(a.id, "target_failed");
    expect(await count(u.id)).toBe(1);
  });

  it("a busy project still reports busy and writes nothing", async () => {
    const { a, u } = await fixture();
    await recordEvent(a.id, "target_failed");
    const snoozedEvent = await recordEvent(a.id, "target_ambiguous");
    await markEventFor(a.id, u.id, snoozedEvent.id, new Date(Date.now() + 60 * 60 * 1000));
    setNotificationsLockTimeoutForTests(150);
    setNotificationsAfterLockHookForTests(null);
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    await client.query("begin");
    await client.query("select id from projects where id = $1 for update", [a.id]);
    try {
      actAs(u);
      const before = await marksFor(a.id, u.id);
      const result = await markAllReadService(await forMyProjects({ user: { id: u.id } }));
      expect(result.busy).toEqual(["Alpha"]);
      expect(await marksFor(a.id, u.id)).toEqual(before);
    } finally {
      await client.query("commit");
      await client.end();
      setNotificationsLockTimeoutForTests(2000);
    }
  });
});
