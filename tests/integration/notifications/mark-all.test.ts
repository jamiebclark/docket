import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);
vi.mock("next/cache", async () => (await import("../../helpers/actions")).cacheModule);
vi.mock("next/navigation", async () => (await import("../../helpers/actions")).navigationModule);

import { markAllRead } from "../../../src/app/notifications/actions";
import { forMyProjects } from "../../../src/server/dal/my-projects";
import { setNotificationsAfterLockHookForTests, setNotificationsLockTimeoutForTests } from "../../../src/server/dal/notifications";
import { setNotificationsBySlug, unreadSummary } from "../../../src/server/services/notifications";
import { actAs, RedirectSignal } from "../../helpers/actions";
import { closeDb } from "../../helpers/db";
import { addMember, createProject, createUser } from "../../helpers/factories";
import { recordEvent, startReading } from "../../helpers/notifications";

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
    expect(result).toEqual({ ok: true, data: { count: 0, busy: [] } });
    expect(await count(u.id)).toBe(0);
  });

  it("marks a muted project's backlog too, so unmuting later shows nothing old", async () => {
    const { a, b, u } = await fixture();
    await setNotificationsBySlug(await forMyProjects({ user: { id: u.id } }), { projectSlug: b.slug, on: "false" });
    await recordEvent(a.id, "target_failed");
    await recordEvent(b.id, "target_failed");
    actAs(u);
    await markAllRead(null, form());
    await setNotificationsBySlug(await forMyProjects({ user: { id: u.id } }), { projectSlug: b.slug, on: "true" });
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
      expect(result).toEqual({ ok: true, data: { count: 1, busy: ["Alpha"] } });
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
