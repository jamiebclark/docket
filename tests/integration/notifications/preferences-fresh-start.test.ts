import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { forMyProjects } from "../../../src/server/dal/my-projects";
import { createNotificationsRepo } from "../../../src/server/dal/notifications";
import { forProject } from "../../../src/server/dal/scope";
import { socialAccounts } from "../../../src/server/db/schema/accounts";
import { markAllRead, markProblemsView, setMySwitchForProject, unreadSummary } from "../../../src/server/services/notifications";
import { closeDb, testDb } from "../../helpers/db";
import { addMember, createProject, createUser } from "../../helpers/factories";
import { fillMarksToCap, marksFor, recordEvent, startReading } from "../../helpers/notifications";

afterAll(async () => {
  await closeDb();
});

const repoOf = (projectId: string, userId: string) => createNotificationsRepo(testDb(), projectId, userId);
const setOf = (userId: string) => forMyProjects({ user: { id: userId } });
const count = async (userId: string) => (await unreadSummary(await setOf(userId))).count;

async function fixture() {
  const project = await createProject({ name: "Woodwork" });
  const u = await createUser();
  await addMember(project.id, u.id, "editor");
  await startReading(project.id, u.id);
  return { project, u };
}

async function seedAccount(projectId: string, providerKey: string): Promise<void> {
  await testDb()
    .insert(socialAccounts)
    .values({ projectId, providerKey, displayName: `${providerKey} account`, externalAccountId: randomUUID() });
}

describe("fresh start on turning a switch back on (US3, FR-004, FR-008)", () => {
  it("a kind: a backlog written while off does not count until turned on, and only from that moment", async () => {
    const { project, u } = await fixture();
    await repoOf(project.id, u.id).setSwitches({ switches: [{ axis: "kind", key: "failed" }], on: false });
    for (let i = 0; i < 150; i++) {
      await recordEvent(project.id, "target_failed");
    }
    expect(await count(u.id)).toBe(0);

    await repoOf(project.id, u.id).setSwitches({ switches: [{ axis: "kind", key: "failed" }], on: true });
    expect(await count(u.id)).toBe(0);

    await recordEvent(project.id, "target_failed");
    expect(await count(u.id)).toBe(1);
  });

  it("a platform: same fresh-start rule", async () => {
    const { project, u } = await fixture();
    await seedAccount(project.id, "tiktok");
    await repoOf(project.id, u.id).setSwitches({ switches: [{ axis: "platform", key: "tiktok" }], on: false });
    for (let i = 0; i < 150; i++) {
      await recordEvent(project.id, "target_failed", { providerKey: "tiktok", providerKeys: ["tiktok"] });
    }
    expect(await count(u.id)).toBe(0);

    await repoOf(project.id, u.id).setSwitches({ switches: [{ axis: "platform", key: "tiktok" }], on: true });
    expect(await count(u.id)).toBe(0);

    await recordEvent(project.id, "target_failed", { providerKey: "tiktok", providerKeys: ["tiktok"] });
    expect(await count(u.id)).toBe(1);
  });

  it('via "Turn all on": every off switch gets its own fresh start, in one transaction', async () => {
    const { project, u } = await fixture();
    await repoOf(project.id, u.id).setSwitches({
      switches: [
        { axis: "kind", key: "failed" },
        { axis: "kind", key: "ambiguous" },
      ],
      on: false,
    });
    for (let i = 0; i < 50; i++) {
      await recordEvent(project.id, "target_failed");
      await recordEvent(project.id, "target_ambiguous");
    }
    expect(await count(u.id)).toBe(0);

    const scope = await forProject({ user: { id: u.id } }, project.slug);
    const change = await setMySwitchForProject(scope, { axis: "project", on: "true" });
    expect(change).toMatchObject({ axis: "project", on: true, changed: true });
    expect(await count(u.id)).toBe(0);

    await recordEvent(project.id, "target_failed");
    expect(await count(u.id)).toBe(1);
  });

  it("switching a kind off marks nothing read and leaves the other kinds' counts unchanged", async () => {
    const { project, u } = await fixture();
    await recordEvent(project.id, "target_failed");
    await recordEvent(project.id, "target_ambiguous");
    expect(await count(u.id)).toBe(2);

    const before = await repoOf(project.id, u.id).get();
    await repoOf(project.id, u.id).setSwitches({ switches: [{ axis: "kind", key: "failed" }], on: false });
    const after = await repoOf(project.id, u.id).get();

    expect(after!.seenSeq).toBe(before!.seenSeq);
    expect(await count(u.id)).toBe(1); // ambiguous still counts
  });

  it("an individually read or snoozed event whose kind is cycled off then on does not count, and leaves no stale mark", async () => {
    const { project, u } = await fixture();
    await recordEvent(project.id, "target_ambiguous"); // keeps the floor from following
    const event = await recordEvent(project.id, "target_failed");
    await repoOf(project.id, u.id).markEvent({ eventId: event.id, countsAgainAt: "never" });
    expect(await marksFor(project.id, u.id)).toHaveLength(1);

    await repoOf(project.id, u.id).setSwitches({ switches: [{ axis: "kind", key: "failed" }], on: false });
    await repoOf(project.id, u.id).setSwitches({ switches: [{ axis: "kind", key: "failed" }], on: true });

    expect(await marksFor(project.id, u.id)).toEqual([]);
    expect(await count(u.id)).toBe(1); // only the still-unread blocker
  });

  it("pruning at the 200-mark cap restores row actions", async () => {
    const { project, u } = await fixture();
    await repoOf(project.id, u.id).setSwitches({ switches: [{ axis: "kind", key: "needs_reauth" }], on: false });
    await fillMarksToCap(project.id, u.id); // 200 marks on account_needs_reauth events, switched off
    expect(await repoOf(project.id, u.id).markCount()).toBe(200);

    const blocked = await recordEvent(project.id, "target_failed");
    expect(await repoOf(project.id, u.id).markEvent({ eventId: blocked.id, countsAgainAt: "never" })).toEqual({ kind: "at_cap" });

    const result = await repoOf(project.id, u.id).setSwitches({ switches: [{ axis: "kind", key: "needs_reauth" }], on: true });
    expect(result.outcome).toBe("changed");
    expect(result.marksPruned).toBe(200);
    expect(await repoOf(project.id, u.id).markCount()).toBe(0);

    expect(await repoOf(project.id, u.id).markEvent({ eventId: blocked.id, countsAgainAt: "never" })).toMatchObject({ kind: "changed" });
  });

  it('"Mark all as read" while a kind was off still hides everything below it once the kind returns', async () => {
    const { project, u } = await fixture();
    await repoOf(project.id, u.id).setSwitches({ switches: [{ axis: "kind", key: "failed" }], on: false });
    for (let i = 0; i < 10; i++) await recordEvent(project.id, "target_failed");
    await recordEvent(project.id, "target_ambiguous");

    await markAllRead(await setOf(u.id));
    expect(await count(u.id)).toBe(0);

    await repoOf(project.id, u.id).setSwitches({ switches: [{ axis: "kind", key: "failed" }], on: true });
    expect(await count(u.id)).toBe(0); // the backlog marked read before the kind returned stays hidden

    await recordEvent(project.id, "target_failed");
    expect(await count(u.id)).toBe(1);
  });

  it("the problems view does the same as Mark all as read", async () => {
    const { project, u } = await fixture();
    await repoOf(project.id, u.id).setSwitches({ switches: [{ axis: "kind", key: "failed" }], on: false });
    for (let i = 0; i < 10; i++) await recordEvent(project.id, "target_failed");

    await markProblemsView(await setOf(u.id), { kind: "project", slug: project.slug });
    await repoOf(project.id, u.id).setSwitches({ switches: [{ axis: "kind", key: "failed" }], on: true });
    expect(await count(u.id)).toBe(0);

    await recordEvent(project.id, "target_failed");
    expect(await count(u.id)).toBe(1);
  });

  it("a second on-write for a switch already on never lowers the recorded position", async () => {
    const { project, u } = await fixture();
    await repoOf(project.id, u.id).setSwitches({ switches: [{ axis: "kind", key: "failed" }], on: false });
    await recordEvent(project.id, "target_failed");

    const first = await repoOf(project.id, u.id).setSwitches({ switches: [{ axis: "kind", key: "failed" }], on: true });
    expect(first.outcome).toBe("changed");
    const prefsAfterFirst = await repoOf(project.id, u.id).preferences();

    const second = await repoOf(project.id, u.id).setSwitches({ switches: [{ axis: "kind", key: "failed" }], on: true });
    expect(second.outcome).toBe("unchanged");
    const prefsAfterSecond = await repoOf(project.id, u.id).preferences();

    expect(prefsAfterSecond.kinds.get("failed")).toBe(prefsAfterFirst.kinds.get("failed"));
  });

  it("an event committed just after the switch flips still counts", async () => {
    const { project, u } = await fixture();
    await repoOf(project.id, u.id).setSwitches({ switches: [{ axis: "kind", key: "failed" }], on: false });
    await repoOf(project.id, u.id).setSwitches({ switches: [{ axis: "kind", key: "failed" }], on: true });

    await recordEvent(project.id, "target_failed");
    expect(await count(u.id)).toBe(1);
  });

  it("engagement: a never-touched switch is on with no stored position, and every pre-existing switch keeps its exact meaning (FR-047, FR-051)", async () => {
    const { project, u } = await fixture();
    expect(await repoOf(project.id, u.id).preferences()).toMatchObject({});
    await recordEvent(project.id, "engagement_received");
    expect(await count(u.id)).toBe(1);

    await recordEvent(project.id, "target_failed");
    await recordEvent(project.id, "target_ambiguous");
    await recordEvent(project.id, "account_needs_reauth");
    expect(await count(u.id)).toBe(4);

    await repoOf(project.id, u.id).setSwitches({ switches: [{ axis: "kind", key: "engagement" }], on: false });
    expect(await count(u.id)).toBe(3); // the engagement event no longer counts while its switch is off
    for (let i = 0; i < 5; i++) await recordEvent(project.id, "engagement_received");
    expect(await count(u.id)).toBe(3);

    await repoOf(project.id, u.id).setSwitches({ switches: [{ axis: "kind", key: "engagement" }], on: true });
    expect(await count(u.id)).toBe(3); // fresh start: the backlog accumulated while off does not count

    await recordEvent(project.id, "engagement_received");
    expect(await count(u.id)).toBe(4);
  });
});
