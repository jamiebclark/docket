import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/session", async () => (await import("../../helpers/actions")).sessionModule);
vi.mock("next/cache", async () => (await import("../../helpers/actions")).cacheModule);
vi.mock("next/navigation", async () => (await import("../../helpers/actions")).navigationModule);

const busyMode = vi.hoisted(() => ({ on: false }));
vi.mock("@/server/services/notifications", async () => {
  const actual = await vi.importActual<typeof import("../../../src/server/services/notifications")>("@/server/services/notifications");
  const { NotificationsBusyError } = await import("../../../src/server/dal/notifications");
  const guard = () => {
    if (busyMode.on) throw new NotificationsBusyError();
  };
  return {
    ...actual,
    setNotificationsBySlug: ((...a: Parameters<typeof actual.setNotificationsBySlug>) => (guard(), actual.setNotificationsBySlug(...a))) as typeof actual.setNotificationsBySlug,
    setMyProjectNotifications: ((...a: Parameters<typeof actual.setMyProjectNotifications>) => (guard(), actual.setMyProjectNotifications(...a))) as typeof actual.setMyProjectNotifications,
  };
});

import { setNotifications } from "../../../src/app/notifications/actions";
import { setMyProjectNotifications } from "../../../src/app/p/[projectSlug]/settings/actions";
import { forMyProjects } from "../../../src/server/dal/my-projects";
import { forProject } from "../../../src/server/dal/scope";
import { listMyActivity } from "../../../src/server/services/activity";
import { myProjectStates, projectUnread, recentPanel, unreadSummary } from "../../../src/server/services/notifications";
import { actAs, RedirectSignal } from "../../helpers/actions";
import { closeDb } from "../../helpers/db";
import { addMember, createProject, createUser } from "../../helpers/factories";
import { recordEvent, startReading } from "../../helpers/notifications";

afterAll(async () => {
  actAs(null);
  await closeDb();
});

const setFor = (id: string) => forMyProjects({ user: { id } });
const count = async (id: string) => (await unreadSummary(await setFor(id))).count;

const form = (entries: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
};

async function fixture() {
  const [a, b] = await Promise.all([createProject({ name: "Alpha" }), createProject({ name: "Bravo" })]);
  const u = await createUser();
  for (const p of [a, b]) {
    await addMember(p.id, u.id, "editor");
    await startReading(p.id, u.id);
  }
  return { a, b, u };
}

const redirectOf = async (run: () => Promise<unknown>) => {
  const error = await run().catch((e: unknown) => e);
  expect(error).toBeInstanceOf(RedirectSignal);
  return (error as RedirectSignal).to;
};

describe("per-project notifications", () => {
  it("is on by default", async () => {
    const { a, b, u } = await fixture();
    const states = await myProjectStates(await setFor(u.id));
    expect(states.filter((s) => [a.slug, b.slug].includes(s.slug)).every((s) => s.on)).toBe(true);
  });

  it("hides a muted project from count, panel and callout while Activity still lists it", async () => {
    const { a, b, u } = await fixture();
    await recordEvent(a.id, "target_failed", { message: "Alpha broke." });
    await recordEvent(b.id, "target_failed", { message: "Bravo broke." });
    actAs(u);
    expect(await count(u.id)).toBe(2);
    const to = await redirectOf(() => setNotifications(null, form({ projectSlug: b.slug, on: "false" })));
    expect(to).toBe(`/notifications?changed=${b.slug}`);
    expect(await count(u.id)).toBe(1);
    const panel = await recentPanel(await setFor(u.id), new Date());
    expect(panel.items.map((i) => i.message)).toEqual(["Alpha broke."]);
    expect((await projectUnread(await forProject({ user: { id: u.id } }, b.slug))).count).toBe(0);
    const activity = await listMyActivity(await setFor(u.id), {});
    expect(activity.rows.map((r) => r.message)).toContain("Bravo broke.");
  });

  it("marks read on unmute: 0 straight after, then 1 for a later problem", async () => {
    const { b, u } = await fixture();
    actAs(u);
    await redirectOf(() => setNotifications(null, form({ projectSlug: b.slug, on: "false" })));
    await recordEvent(b.id, "target_failed");
    await redirectOf(() => setNotifications(null, form({ projectSlug: b.slug, on: "true" })));
    expect(await count(u.id)).toBe(0);
    await recordEvent(b.id, "target_failed");
    expect(await count(u.id)).toBe(1);
  });

  it("lets an editor mute from the project settings", async () => {
    const { a, u } = await fixture();
    await recordEvent(a.id, "target_failed");
    actAs(u);
    const to = await redirectOf(() => setMyProjectNotifications(null, form({ projectSlug: a.slug, on: "false" })));
    expect(to).toBe(`/p/${a.slug}/settings?notifications=off`);
    expect(await count(u.id)).toBe(0);
    expect(await redirectOf(() => setMyProjectNotifications(null, form({ projectSlug: a.slug, on: "true" })))).toBe(
      `/p/${a.slug}/settings?notifications=on`,
    );
  });

  it("answers a foreign slug exactly like a nonexistent one, by redirecting with not_found", async () => {
    const { u } = await fixture();
    const foreign = await createProject({ name: "Foreign" });
    actAs(u);
    const real = await redirectOf(() => setNotifications(null, form({ projectSlug: foreign.slug, on: "false" })));
    const none = await redirectOf(() => setNotifications(null, form({ projectSlug: "no-such-project", on: "false" })));
    expect(real).toBe("/notifications?notifications=not_found");
    expect(none).toBe(real);
  });

  it("redirects with invalid for a malformed switch and busy when the write is locked, on both forms", async () => {
    const { a, u } = await fixture();
    actAs(u);
    expect(await redirectOf(() => setNotifications(null, form({ projectSlug: a.slug, on: "maybe" })))).toBe("/notifications?notifications=invalid");
    expect(await redirectOf(() => setMyProjectNotifications(null, form({ projectSlug: a.slug, on: "maybe" })))).toBe(
      `/p/${a.slug}/settings?notifications=invalid`,
    );
    expect(await redirectOf(() => setMyProjectNotifications(null, form({ projectSlug: "no-such-project", on: "false" })))).toBe(
      "/p/no-such-project/settings?notifications=not_found",
    );
    busyMode.on = true;
    try {
      expect(await redirectOf(() => setNotifications(null, form({ projectSlug: a.slug, on: "false" })))).toBe("/notifications?notifications=busy");
      expect(await redirectOf(() => setMyProjectNotifications(null, form({ projectSlug: a.slug, on: "false" })))).toBe(
        `/p/${a.slug}/settings?notifications=busy`,
      );
    } finally {
      busyMode.on = false;
    }
  });

  it("sends a signed-out caller to login", async () => {
    actAs(null);
    expect(await redirectOf(() => setNotifications(null, form({ projectSlug: "x", on: "false" })))).toBe("/login?next=/notifications");
  });
});
