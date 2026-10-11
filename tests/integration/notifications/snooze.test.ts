import { afterAll, describe, expect, it } from "vitest";
import { forMyProjects } from "../../../src/server/dal/my-projects";
import { createNotificationsRepo, createNotificationsSetReader } from "../../../src/server/dal/notifications";
import { recentPanel, snoozeEvent, markEventRead, projectUnread, unreadSummary } from "../../../src/server/services/notifications";
import { forProject } from "../../../src/server/dal/scope";
import { closeDb, testDb } from "../../helpers/db";
import { addMember, createProject, createUser } from "../../helpers/factories";
import { recordEvent, startReading, marksFor } from "../../helpers/notifications";

afterAll(async () => {
  await closeDb();
});

const BRANCH_Q = { outcomes: null, platform: null, accountId: null, cursor: null, direction: "older" as const, limit: 10 };
const repoOf = (projectId: string, userId: string) => createNotificationsRepo(testDb(), projectId, userId);

async function fixture() {
  const [project, other] = await Promise.all([createProject({ name: "Alpha" }), createProject({ name: "Bravo" })]);
  const owner = await createUser();
  const snoozer = await createUser();
  await addMember(project.id, owner.id, "owner");
  await addMember(project.id, snoozer.id, "editor");
  await addMember(other.id, snoozer.id, "editor");
  await startReading(project.id, owner.id);
  await startReading(project.id, snoozer.id);
  await startReading(other.id, snoozer.id);
  return { project, other, owner, snoozer };
}

const setOf = (userId: string) => forMyProjects({ user: { id: userId } });

describe("snoozing a problem (N17 to N20, FR-010 to FR-014)", () => {
  it("is absent from the count, the panel, /notifications-equivalent and the callout, present in both Activity screens for everyone", async () => {
    const { project, owner, snoozer } = await fixture();
    const e = await recordEvent(project.id, "target_failed", { message: "Boom." });

    expect(await unreadSummary(await setOf(snoozer.id))).toMatchObject({ count: 1 });
    const result = await snoozeEvent(await setOf(snoozer.id), { eventId: e.id, choice: "hour" });
    expect(result.noop).toBe(false);
    expect(result.until).toBeInstanceOf(Date);

    // Count, panel and callout all drop it.
    expect(await unreadSummary(await setOf(snoozer.id))).toMatchObject({ count: 0 });
    const panel = await recentPanel(await setOf(snoozer.id), new Date());
    expect(panel.items.some((i) => i.id === e.id)).toBe(false);
    const callout = await projectUnread(await forProject({ user: { id: snoozer.id } }, project.slug));
    expect(callout.count).toBe(0);

    // Activity (both screens) still has it, for the snoozer and for everyone else.
    const ownerScope = await forProject({ user: { id: owner.id } }, project.slug);
    const ownerActivity = await ownerScope.activity.list({ ...BRANCH_Q, windows: [{ projectId: project.id, from: null, to: null }] });
    expect(ownerActivity.some((r) => r.id === e.id)).toBe(true);
    const snoozerSet = await setOf(snoozer.id);
    const snoozerCrossActivity = await snoozerSet.activity.list({
      ...BRANCH_Q,
      windows: snoozerSet.projects.map((p) => ({ projectId: p.id, from: null, to: null })),
    });
    expect(snoozerCrossActivity.some((r) => r.id === e.id)).toBe(true);
  });

  it("seeding its instant in the past brings it back counted and New with no job run", async () => {
    const { project, snoozer } = await fixture();
    const e = await recordEvent(project.id, "target_failed");
    await snoozeEvent(await setOf(snoozer.id), { eventId: e.id, choice: "hour" });
    expect(await unreadSummary(await setOf(snoozer.id))).toMatchObject({ count: 0 });

    // Re-snooze to an already-past instant directly: `resolveSnooze`'s "strictly in the future" rule is
    // enforced only at snooze time, not by the DAL, so this is exactly what the real clock running out looks like.
    const past = new Date(Date.now() - 1000);
    await repoOf(project.id, snoozer.id).markEvent({ eventId: e.id, countsAgainAt: past });
    expect(await unreadSummary(await setOf(snoozer.id))).toMatchObject({ count: 1 });
    const panel = await recentPanel(await setOf(snoozer.id), new Date());
    const item = panel.items.find((i) => i.id === e.id);
    expect(item?.isNew).toBe(true);
  });

  it("re-snoozing replaces the instant in both directions", async () => {
    const { project, snoozer } = await fixture();
    const e = await recordEvent(project.id, "target_failed");
    await snoozeEvent(await setOf(snoozer.id), { eventId: e.id, choice: "hour" });
    const marksBefore = await marksFor(project.id, snoozer.id);
    expect(marksBefore).toHaveLength(1);

    await snoozeEvent(await setOf(snoozer.id), { eventId: e.id, choice: "next_week" });
    const marksAfter = await marksFor(project.id, snoozer.id);
    expect(marksAfter).toHaveLength(1);
    expect(marksAfter[0]!.countsAgainAt).not.toBe(marksBefore[0]!.countsAgainAt);
  });

  it("'Mark read' over a snooze replaces it and the event never returns", async () => {
    const { project, snoozer } = await fixture();
    const e = await recordEvent(project.id, "target_failed");
    await snoozeEvent(await setOf(snoozer.id), { eventId: e.id, choice: "hour" });
    await markEventRead(await setOf(snoozer.id), { eventId: e.id });
    expect(await unreadSummary(await setOf(snoozer.id))).toMatchObject({ count: 0 });

    // A later attempt to make it live again (what an expired snooze would do) changes nothing: the
    // floor (or the read-for-ever mark it may have left) already covers it for good (I2, FR-005).
    const outcome = await repoOf(project.id, snoozer.id).markEvent({ eventId: e.id, countsAgainAt: new Date(Date.now() - 1000) });
    expect(outcome.kind).toBe("unchanged");
    expect(await unreadSummary(await setOf(snoozer.id))).toMatchObject({ count: 0 });
    const panel = await recentPanel(await setOf(snoozer.id), new Date());
    const item = panel.items.find((i) => i.id === e.id);
    expect(item).toBeDefined();
    expect(item?.isNew).toBe(false);
  });

  it("a snooze whose target is retried, published and resolved still returns unread once it expires", async () => {
    const { project, snoozer } = await fixture();
    const e = await recordEvent(project.id, "target_failed");
    await snoozeEvent(await setOf(snoozer.id), { eventId: e.id, choice: "hour" });
    const past = new Date(Date.now() - 1000);
    await repoOf(project.id, snoozer.id).markEvent({ eventId: e.id, countsAgainAt: past });
    // The mark join is on (project_id, user_id, event_id) only — no join to posts, post_targets or
    // social_accounts (N18) — so the event's own later outcome never factors into whether it counts.
    const panel = await recentPanel(await setOf(snoozer.id), new Date());
    const item = panel.items.find((i) => i.id === e.id);
    expect(item?.isNew).toBe(true);
  });

  it("a stored instant flips the count at exactly itself, neither early nor late", async () => {
    // `resolveSnooze`'s own DST handling is unit-tested in src/lib/notifications/snooze.test.ts (T006);
    // this checks the DAL compares the stored absolute instant directly, with no zone shift of its own.
    const { project, snoozer } = await fixture();
    const e = await recordEvent(project.id, "target_failed");
    const soon = new Date(Date.now() + 1000);
    await repoOf(project.id, snoozer.id).markEvent({ eventId: e.id, countsAgainAt: soon });
    expect(await unreadSummary(await setOf(snoozer.id))).toMatchObject({ count: 0 });
    await new Promise((r) => setTimeout(r, 1200));
    expect(await unreadSummary(await setOf(snoozer.id))).toMatchObject({ count: 1 });
  });

  it("nextChangeAt is the soonest live snooze over notifications-on projects, null with none, ignoring a muted project's and another person's snoozes", async () => {
    const { project, other, snoozer } = await fixture();
    expect(await unreadSummary(await setOf(snoozer.id))).toMatchObject({ nextChangeAt: null });

    const a = await recordEvent(project.id, "target_failed");
    const soon = await snoozeEvent(await setOf(snoozer.id), { eventId: a.id, choice: "hour" });

    const b = await recordEvent(other.id, "target_failed");
    await snoozeEvent(await setOf(snoozer.id), { eventId: b.id, choice: "next_week" });

    expect(await unreadSummary(await setOf(snoozer.id))).toMatchObject({ nextChangeAt: soon.until!.toISOString() });

    // Muting the soonest project's notifications drops its snooze from the window entirely.
    await repoOf(project.id, snoozer.id).write({ markRead: false, muted: true });
    const afterMute = await unreadSummary(await setOf(snoozer.id));
    expect(afterMute.nextChangeAt).not.toBe(soon.until!.toISOString());

    // Another person's snooze in the same project never counts for this one.
    const owner = await createUser();
    await addMember(project.id, owner.id, "owner");
    await startReading(project.id, owner.id);
    expect((await createNotificationsSetReader(testDb(), [project.id], owner.id).nextChangeAt())).toBeNull();
  });
});
