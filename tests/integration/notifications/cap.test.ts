import { afterAll, afterEach, describe, expect, it } from "vitest";
import { forMyProjects } from "../../../src/server/dal/my-projects";
import { createNotificationsRepo, setNotificationsAfterLockHookForTests, setNotificationsLockTimeoutForTests } from "../../../src/server/dal/notifications";
import { markProblemsView, recentPanel, unreadSummary } from "../../../src/server/services/notifications";
import { closeDb, testDb } from "../../helpers/db";
import { addMember, createProject, createUser } from "../../helpers/factories";
import { fillMarksToCap, markEventFor, marksFor, recordEvent, startReading } from "../../helpers/notifications";

afterEach(() => {
  setNotificationsAfterLockHookForTests(null);
  setNotificationsLockTimeoutForTests(2000);
});
afterAll(async () => {
  await closeDb();
});

const repoOf = (projectId: string, userId: string) => createNotificationsRepo(testDb(), projectId, userId);
const setOf = (userId: string) => forMyProjects({ user: { id: userId } });
const count = async (userId: string) => (await unreadSummary(await setOf(userId))).count;

async function fixture() {
  const [a, b] = await Promise.all([createProject({ name: "Alpha" }), createProject({ name: "Bravo" })]);
  const u = await createUser();
  for (const p of [a, b]) {
    await addMember(p.id, u.id, "editor");
    await startReading(p.id, u.id);
  }
  return { a, b, u };
}

describe("the 200 mark cap (US4, N16, FR-007, FR-020)", () => {
  it("filling newest-first with the oldest left unread refuses the 201st row action without writing", async () => {
    const { a, b, u } = await fixture();
    const oldest = await recordEvent(a.id, "target_failed");
    await fillMarksToCap(a.id, u.id);
    await recordEvent(b.id, "target_failed");

    expect(await repoOf(a.id, u.id).markCount()).toBe(200);
    const result = await repoOf(a.id, u.id).markEvent({ eventId: oldest.id, countsAgainAt: "never" });
    expect(result).toEqual({ kind: "at_cap" });
    expect(await repoOf(a.id, u.id).markCount()).toBe(200);
    expect(await count(u.id)).toBe(2); // the oldest event in a, plus the unread event in b

    const panel = await recentPanel(await setOf(u.id), new Date());
    expect(panel.state).toBe("ok");
    const itemInProject = (slug: string) => panel.items.find((i) => i.project.slug === slug);
    expect(itemInProject(a.slug)?.actionsAvailable).toBe(false);
    expect(itemInProject(b.slug)?.actionsAvailable).toBe(true);
  });

  it("re-marking an event already at the cap is refused too, even though it would not grow the table (M9)", async () => {
    const { a, u } = await fixture();
    await fillMarksToCap(a.id, u.id);
    const marks = await marksFor(a.id, u.id);
    const alreadyMarked = marks[0]!.eventId;

    const result = await repoOf(a.id, u.id).markEvent({ eventId: alreadyMarked, countsAgainAt: "never" });
    expect(result).toEqual({ kind: "at_cap" });
    expect(await repoOf(a.id, u.id).markCount()).toBe(200);
  });

  it("two connections racing at 199 produce 200 rows, never 201", async () => {
    const { a, u } = await fixture();
    await recordEvent(a.id, "target_failed"); // left unread, blocks the floor from following
    for (let i = 0; i < 199; i++) {
      const event = await recordEvent(a.id, "account_needs_reauth");
      await markEventFor(a.id, u.id, event.id);
    }
    expect(await repoOf(a.id, u.id).markCount()).toBe(199);
    const x = await recordEvent(a.id, "target_failed");
    const y = await recordEvent(a.id, "target_ambiguous");

    const [r1, r2] = await Promise.all([
      repoOf(a.id, u.id).markEvent({ eventId: x.id, countsAgainAt: "never" }),
      repoOf(a.id, u.id).markEvent({ eventId: y.id, countsAgainAt: "never" }),
    ]);
    expect([r1.kind, r2.kind].sort()).toEqual(["at_cap", "changed"]);
    expect(await repoOf(a.id, u.id).markCount()).toBe(200);
    expect(await count(u.id)).toBe(2); // oldest, plus whichever of x/y lost the race
  });

  it("Mark all as read prunes all 200 and row actions work again", async () => {
    const { a, u } = await fixture();
    await recordEvent(a.id, "target_failed");
    await fillMarksToCap(a.id, u.id);

    expect(await repoOf(a.id, u.id).write({ markRead: true })).toEqual({ outcome: "changed", snoozesCleared: 0 });
    expect(await marksFor(a.id, u.id)).toEqual([]);
    expect(await count(u.id)).toBe(0);

    const next = await recordEvent(a.id, "target_failed");
    const result = await repoOf(a.id, u.id).markEvent({ eventId: next.id, countsAgainAt: "never" });
    expect(result.kind).toBe("changed");
  });

  it("opening the project's problems view does the same", async () => {
    const { a, u } = await fixture();
    await recordEvent(a.id, "target_failed");
    await fillMarksToCap(a.id, u.id);

    await markProblemsView(await setOf(u.id), { kind: "project", slug: a.slug });
    expect(await marksFor(a.id, u.id)).toEqual([]);

    const next = await recordEvent(a.id, "target_failed");
    const result = await repoOf(a.id, u.id).markEvent({ eventId: next.id, countsAgainAt: "never" });
    expect(result.kind).toBe("changed");
  });
});
