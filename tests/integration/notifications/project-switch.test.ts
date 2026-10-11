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
    setSwitchBySlug: ((...a: Parameters<typeof actual.setSwitchBySlug>) => (guard(), actual.setSwitchBySlug(...a))) as typeof actual.setSwitchBySlug,
    setMySwitchForProject: ((...a: Parameters<typeof actual.setMySwitchForProject>) =>
      (guard(), actual.setMySwitchForProject(...a))) as typeof actual.setMySwitchForProject,
  };
});

import { markEventRead, setNotifications, snoozeEvent } from "../../../src/app/notifications/actions";
import { setMyProjectNotifications } from "../../../src/app/p/[projectSlug]/settings/actions";
import { forMyProjects } from "../../../src/server/dal/my-projects";
import { forProject } from "../../../src/server/dal/scope";
import { listMyActivity } from "../../../src/server/services/activity";
import { myNotificationPreferences, projectUnread, recentPanel, unreadSummary } from "../../../src/server/services/notifications";
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

describe("the project-level switch (axis: project)", () => {
  it("is on by default", async () => {
    const { a, b, u } = await fixture();
    const rows = await myNotificationPreferences(await setFor(u.id));
    expect(rows.filter((r) => [a.slug, b.slug].includes(r.slug)).every((r) => r.on)).toBe(true);
  });

  it("hides a turned-off project from count, panel and callout while Activity still lists it", async () => {
    const { a, b, u } = await fixture();
    await recordEvent(a.id, "target_failed", { message: "Alpha broke." });
    await recordEvent(b.id, "target_failed", { message: "Bravo broke." });
    actAs(u);
    expect(await count(u.id)).toBe(2);
    const to = await redirectOf(() => setNotifications(null, form({ projectSlug: b.slug, axis: "project", on: "false" })));
    expect(to).toBe(`/notifications?changed=${b.slug}&axis=project&on=0`);
    expect(await count(u.id)).toBe(1);
    const panel = await recentPanel(await setFor(u.id), new Date());
    expect(panel.items.map((i) => i.message)).toEqual(["Alpha broke."]);
    expect((await projectUnread(await forProject({ user: { id: u.id } }, b.slug))).count).toBe(0);
    const activity = await listMyActivity(await setFor(u.id), {});
    expect(activity.rows.map((r) => r.message)).toContain("Bravo broke.");
  });

  it("marks read on turning back on: 0 straight after, then 1 for a later problem", async () => {
    const { b, u } = await fixture();
    actAs(u);
    await redirectOf(() => setNotifications(null, form({ projectSlug: b.slug, axis: "project", on: "false" })));
    await recordEvent(b.id, "target_failed");
    await redirectOf(() => setNotifications(null, form({ projectSlug: b.slug, axis: "project", on: "true" })));
    expect(await count(u.id)).toBe(0);
    await recordEvent(b.id, "target_failed");
    expect(await count(u.id)).toBe(1);
  });

  it("lets an editor turn the project switch off from the project settings", async () => {
    const { a, u } = await fixture();
    await recordEvent(a.id, "target_failed");
    actAs(u);
    const to = await redirectOf(() => setMyProjectNotifications(null, form({ projectSlug: a.slug, axis: "project", on: "false" })));
    expect(to).toBe(`/p/${a.slug}/settings?changed=1&axis=project&on=0`);
    expect(await count(u.id)).toBe(0);
    expect(await redirectOf(() => setMyProjectNotifications(null, form({ projectSlug: a.slug, axis: "project", on: "true" })))).toBe(
      `/p/${a.slug}/settings?changed=1&axis=project&on=1`,
    );
  });

  it("answers a foreign slug exactly like a nonexistent one, by redirecting with not_found", async () => {
    const { u } = await fixture();
    const foreign = await createProject({ name: "Foreign" });
    actAs(u);
    const real = await redirectOf(() => setNotifications(null, form({ projectSlug: foreign.slug, axis: "project", on: "false" })));
    const none = await redirectOf(() => setNotifications(null, form({ projectSlug: "no-such-project", axis: "project", on: "false" })));
    expect(real).toBe("/notifications?notifications=not_found");
    expect(none).toBe(real);
  });

  it("redirects with invalid for a malformed switch and busy when the write is locked, on both forms", async () => {
    const { a, u } = await fixture();
    actAs(u);
    expect(await redirectOf(() => setNotifications(null, form({ projectSlug: a.slug, axis: "project", on: "maybe" })))).toBe(
      "/notifications?notifications=invalid",
    );
    expect(await redirectOf(() => setMyProjectNotifications(null, form({ projectSlug: a.slug, axis: "project", on: "maybe" })))).toBe(
      `/p/${a.slug}/settings?notifications=invalid`,
    );
    expect(
      await redirectOf(() => setMyProjectNotifications(null, form({ projectSlug: "no-such-project", axis: "project", on: "false" }))),
    ).toBe("/p/no-such-project/settings?notifications=not_found");
    busyMode.on = true;
    try {
      expect(await redirectOf(() => setNotifications(null, form({ projectSlug: a.slug, axis: "project", on: "false" })))).toBe(
        "/notifications?notifications=busy",
      );
      expect(await redirectOf(() => setMyProjectNotifications(null, form({ projectSlug: a.slug, axis: "project", on: "false" })))).toBe(
        `/p/${a.slug}/settings?notifications=busy`,
      );
    } finally {
      busyMode.on = false;
    }
  });

  it("sends a signed-out caller to login", async () => {
    actAs(null);
    expect(await redirectOf(() => setNotifications(null, form({ projectSlug: "x", axis: "project", on: "false" })))).toBe(
      "/login?next=/notifications",
    );
  });
});

describe("row actions touch only the acting member's own state (FR-025, US7-AS1, AS2)", () => {
  it("an editor's row actions change only their own count, panel and callout", async () => {
    const a = await createProject({ name: "Alpha" });
    const [editor, other] = await Promise.all([createUser(), createUser()]);
    await Promise.all([addMember(a.id, editor.id, "editor"), addMember(a.id, other.id, "owner")]);
    await Promise.all([startReading(a.id, editor.id), startReading(a.id, other.id)]);
    const [toRead, toSnooze] = await Promise.all([recordEvent(a.id, "target_failed"), recordEvent(a.id, "target_failed")]);

    actAs(editor);
    const readResult = await markEventRead(null, form({ eventId: toRead.id }));
    expect(readResult.ok).toBe(true);
    const snoozeResult = await snoozeEvent(null, form({ eventId: toSnooze.id, choice: "hour" }));
    expect(snoozeResult.ok).toBe(true);

    expect(await count(editor.id)).toBe(0);
    const otherPanel = await recentPanel(await setFor(other.id), new Date());
    expect(otherPanel.items).toHaveLength(2);
    expect(otherPanel.items.every((i) => i.isNew)).toBe(true);
    expect((await projectUnread(await forProject({ user: { id: other.id } }, a.slug))).count).toBe(2);
  });

  it("refuses a non-member actor before writing anything", async () => {
    const a = await createProject({ name: "Alpha" });
    const outsider = await createUser();
    const event = await recordEvent(a.id, "target_failed");

    actAs(outsider);
    const readResult = await markEventRead(null, form({ eventId: event.id }));
    expect(readResult).toMatchObject({ ok: false, error: "not_found" });
    const snoozeResult = await snoozeEvent(null, form({ eventId: event.id, choice: "hour" }));
    expect(snoozeResult).toMatchObject({ ok: false, error: "not_found" });

    actAs(null);
    expect(await redirectOf(() => markEventRead(null, form({ eventId: event.id })))).toBe("/login?next=/notifications");
    expect(await redirectOf(() => snoozeEvent(null, form({ eventId: event.id, choice: "hour" })))).toBe("/login?next=/notifications");
  });
});
