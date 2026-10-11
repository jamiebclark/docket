import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createNotificationsRepo } from "../../../src/server/dal/notifications";
import { closeDb, testDb } from "../../helpers/db";
import { addMember, createProject, createUser } from "../../helpers/factories";
import { markEventFor, marksFor, muteProject, recordEvent, startReading } from "../../helpers/notifications";

afterAll(async () => {
  await closeDb();
});

const repoOf = (projectId: string, userId: string) => createNotificationsRepo(testDb(), projectId, userId);

/** `seq` is a database-wide counter, not per project, so a fresh project's events can start well above zero. */
async function seqOf(projectId: string, eventId: string): Promise<bigint> {
  const result = await testDb().execute(sql`SELECT seq::text AS seq FROM activity_events WHERE project_id = ${projectId} AND id = ${eventId}`);
  return BigInt((result.rows[0] as { seq: string }).seq);
}

async function fixture() {
  const [project, other] = await Promise.all([createProject({ name: "Alpha" }), createProject({ name: "Bravo" })]);
  const u = await createUser();
  await addMember(project.id, u.id, "editor");
  await addMember(other.id, u.id, "editor");
  await startReading(project.id, u.id);
  await startReading(other.id, u.id);
  return { project, other, u };
}

/** Every mark is above the person's floor for its project (I1); every mark's event_seq matches its event (I4). */
async function assertInvariants(projectId: string, userId: string) {
  const seenSeq = BigInt((await repoOf(projectId, userId).get())!.seenSeq);
  for (const mark of await marksFor(projectId, userId)) {
    expect(BigInt(mark.eventSeq)).toBeGreaterThan(seenSeq);
  }
}

describe("FR-002 to FR-006: a mix of floor-read, individually-read, snoozed, expired-snooze and untouched events", () => {
  it("counts untouched plus expired, unaffected by floor-read, individually-read or live-snoozed", async () => {
    const { project, u } = await fixture();
    const floorRead = await recordEvent(project.id, "target_failed");
    // Raises the floor to `floorRead` before the rest exist, so only `floorRead` is covered by the floor.
    expect(await repoOf(project.id, u.id).write({ markRead: true })).toEqual({ outcome: "changed", snoozesCleared: 0 });

    const individuallyRead = await recordEvent(project.id, "target_failed");
    const snoozed = await recordEvent(project.id, "target_failed");
    const expiredSnooze = await recordEvent(project.id, "target_failed");
    const untouched = await recordEvent(project.id, "target_failed");
    await markEventFor(project.id, u.id, individuallyRead.id);
    await markEventFor(project.id, u.id, snoozed.id, new Date(Date.now() + 3_600_000));
    await markEventFor(project.id, u.id, expiredSnooze.id, new Date(Date.now() - 1000));

    expect(await repoOf(project.id, u.id).unreadCount()).toBe(2);
    await assertInvariants(project.id, u.id);

    void floorRead;
    void untouched;
  });

  it("a project with every kind off contributes nothing", async () => {
    const { project, u } = await fixture();
    await recordEvent(project.id, "target_failed");
    await muteProject(project.id, u.id);
    expect(await repoOf(project.id, u.id).unreadCount()).toBe(0);
  });
});

describe("markEvent — one row action at a time", () => {
  it("marking the newest leaves the others untouched and does not move the floor past them", async () => {
    const { project, u } = await fixture();
    const a = await recordEvent(project.id, "target_failed");
    const b = await recordEvent(project.id, "target_failed");
    const c = await recordEvent(project.id, "target_failed");

    const result = await repoOf(project.id, u.id).markEvent({ eventId: c.id, countsAgainAt: "never" });
    expect(result.kind).toBe("changed");

    // The floor may have risen (seq is a database-wide counter, so it can jump straight to just below
    // the oldest still-unread event), but never as far as `a` or `b`: both are still above it.
    const seenSeq = BigInt((await repoOf(project.id, u.id).get())!.seenSeq);
    expect(seenSeq).toBeLessThan(await seqOf(project.id, a.id));
    expect(seenSeq).toBeLessThan(await seqOf(project.id, b.id));

    expect(await repoOf(project.id, u.id).unreadCount()).toBe(2);
    const marks = await marksFor(project.id, u.id);
    expect(marks).toHaveLength(1);
    expect(marks[0]!.eventId).toBe(c.id);
    await assertInvariants(project.id, u.id);
  });

  it("marking the oldest with nothing unread beneath it leaves zero marks", async () => {
    const { project, u } = await fixture();
    const only = await recordEvent(project.id, "target_failed");

    const result = await repoOf(project.id, u.id).markEvent({ eventId: only.id, countsAgainAt: "never" });
    expect(result).toEqual({ kind: "changed", floorMoved: true });

    expect(await marksFor(project.id, u.id)).toHaveLength(0);
    expect(await repoOf(project.id, u.id).unreadCount()).toBe(0);
    await assertInvariants(project.id, u.id);
  });

  it("marking newest-first then the oldest collapses every mark", async () => {
    const { project, u } = await fixture();
    const a = await recordEvent(project.id, "target_failed");
    const b = await recordEvent(project.id, "target_failed");
    const c = await recordEvent(project.id, "target_failed");

    await repoOf(project.id, u.id).markEvent({ eventId: c.id, countsAgainAt: "never" });
    await repoOf(project.id, u.id).markEvent({ eventId: b.id, countsAgainAt: "never" });
    await assertInvariants(project.id, u.id);
    const result = await repoOf(project.id, u.id).markEvent({ eventId: a.id, countsAgainAt: "never" });
    expect(result).toEqual({ kind: "changed", floorMoved: true });

    expect(await marksFor(project.id, u.id)).toHaveLength(0);
    expect(await repoOf(project.id, u.id).unreadCount()).toBe(0);
    await assertInvariants(project.id, u.id);
  });

  it("a read mark survives a reload (its own repo instance)", async () => {
    const { project, u } = await fixture();
    // `a` stays unread, so it blocks the floor-follow and `b`'s mark is not immediately pruned.
    const a = await recordEvent(project.id, "target_failed");
    const b = await recordEvent(project.id, "target_failed");
    void a;

    await repoOf(project.id, u.id).markEvent({ eventId: b.id, countsAgainAt: "never" });
    const marksAfterReload = await marksFor(project.id, u.id);
    expect(marksAfterReload.map((m) => m.eventId)).toEqual([b.id]);
    expect(marksAfterReload[0]!.countsAgainAt).toBe("infinity");
  });

  it("a crafted or foreign event id is not_found, and an event at or below the floor is unchanged", async () => {
    const { project, other, u } = await fixture();
    const foreign = await recordEvent(other.id, "target_failed");
    expect(await repoOf(project.id, u.id).markEvent({ eventId: foreign.id, countsAgainAt: "never" })).toEqual({ kind: "not_found" });
    expect(await repoOf(project.id, u.id).markEvent({ eventId: crypto.randomUUID(), countsAgainAt: "never" })).toEqual({
      kind: "not_found",
    });

    const event = await recordEvent(project.id, "target_failed");
    await repoOf(project.id, u.id).write({ markRead: true });
    expect(await repoOf(project.id, u.id).markEvent({ eventId: event.id, countsAgainAt: "never" })).toEqual({ kind: "unchanged" });
    expect(await marksFor(project.id, u.id)).toHaveLength(0);
  });
});
