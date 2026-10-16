import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { ATTENTION_KINDS, mayNotify } from "../../../src/lib/notifications/eligibility";
import { forMyProjects } from "../../../src/server/dal/my-projects";
import { createNotificationsRepo } from "../../../src/server/dal/notifications";
import { forProject } from "../../../src/server/dal/scope";
import { listMyActivity } from "../../../src/server/services/activity";
import { projectUnread, recentPanel, unreadSummary } from "../../../src/server/services/notifications";
import { closeDb, testDb } from "../../helpers/db";
import { addMember, createProject, createUser } from "../../helpers/factories";
import { recordEvent, startReading } from "../../helpers/notifications";

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

const KIND_FOR_OUTCOME = {
  failed: "target_failed",
  ambiguous: "target_ambiguous",
  needs_reauth: "account_needs_reauth",
  connect_failed: "account_connect_failed",
  engagement: "engagement_received",
} as const;

async function seedOneOfEachKind(projectId: string, actorUserId: string) {
  const events: Record<string, { id: string; message: string }> = {};
  for (const outcome of ATTENTION_KINDS) {
    const message = `${outcome}.`;
    const { id } = await recordEvent(projectId, KIND_FOR_OUTCOME[outcome], {
      message,
      ...(outcome === "connect_failed" ? { actorUserId } : {}),
    });
    events[outcome] = { id, message };
  }
  return events;
}

async function eventRow(projectId: string, id: string): Promise<{ seq: bigint; outcome: string; providerKeys: string[] }> {
  const result = await testDb().execute(
    sql`SELECT seq::text AS seq, outcome, provider_keys FROM activity_events WHERE project_id = ${projectId} AND id = ${id}`,
  );
  const row = result.rows[0] as { seq: string; outcome: string; provider_keys: string[] };
  return { seq: BigInt(row.seq), outcome: row.outcome, providerKeys: row.provider_keys };
}

describe("per-kind preferences (US1, FR-003)", () => {
  it("turning one kind off drops the count by exactly that kind, omits it from the panel and the callout, and leaves Activity unchanged for everyone", async () => {
    const { a, b, u } = await fixture();
    const other = await createUser();
    await addMember(a.id, other.id, "editor");
    await startReading(a.id, other.id);
    const events = await seedOneOfEachKind(a.id, u.id);
    await recordEvent(b.id, "target_failed", { message: "Bravo broke." });

    expect(await count(u.id)).toBe(6); // 5 in Alpha, 1 in Bravo
    expect(await count(other.id)).toBe(4); // Alpha only (connect_failed counts for its actor alone); not a member of Bravo

    await repoOf(a.id, u.id).setSwitches({ switches: [{ axis: "kind", key: "failed" }], on: false });

    expect(await count(u.id)).toBe(5); // 4 remaining in Alpha, 1 in Bravo
    expect(await count(other.id)).toBe(4); // this person's switch does not touch another member's count

    const panel = await recentPanel(await setOf(u.id), new Date());
    expect(panel.items.map((i) => i.message)).not.toContain(events.failed!.message);
    expect(panel.items).toHaveLength(5);

    expect((await projectUnread(await forProject({ user: { id: u.id } }, a.slug))).count).toBe(4);

    const activity = await listMyActivity(await setOf(u.id), {});
    expect(activity.rows.map((r) => r.message)).toContain(events.failed!.message);
  });

  it("a person with no preference row behaves exactly like today's unmuted project", async () => {
    const { a, u } = await fixture();
    await seedOneOfEachKind(a.id, u.id);
    expect(await count(u.id)).toBe(5);
  });

  it("turning every kind off makes the project contribute nothing and read as off in words", async () => {
    const a = await createProject({ name: "Alpha" });
    const u = await createUser();
    await addMember(a.id, u.id, "editor");
    await startReading(a.id, u.id);
    await seedOneOfEachKind(a.id, u.id);
    for (const outcome of ATTENTION_KINDS) {
      await repoOf(a.id, u.id).setSwitches({ switches: [{ axis: "kind", key: outcome }], on: false });
    }
    expect(await count(u.id)).toBe(0);
    const panel = await recentPanel(await setOf(u.id), new Date());
    expect(panel.state).toBe("all_muted");
    expect((await projectUnread(await forProject({ user: { id: u.id } }, a.slug))).count).toBe(0);
  });

  it("the 100-event cap still applies with a kind switched off", async () => {
    const { a, u } = await fixture();
    await repoOf(a.id, u.id).setSwitches({ switches: [{ axis: "kind", key: "ambiguous" }], on: false });
    for (let i = 0; i < 150; i++) {
      await recordEvent(a.id, "target_failed");
    }
    expect(await count(u.id)).toBe(100);
  });
});

describe("anti-drift: the database's count equals mayNotify's count for the same events (Q4)", () => {
  it("agrees over every combination of the kind switches", async () => {
    for (let mask = 0; mask < 1 << ATTENTION_KINDS.length; mask++) {
      const project = await createProject({ name: `Combo ${mask}` });
      const u = await createUser();
      await addMember(project.id, u.id, "editor");
      await startReading(project.id, u.id);
      const events = await seedOneOfEachKind(project.id, u.id);

      const offOutcomes = ATTENTION_KINDS.filter((_, i) => (mask & (1 << i)) !== 0);
      if (offOutcomes.length > 0) {
        await repoOf(project.id, u.id).setSwitches({
          switches: offOutcomes.map((key) => ({ axis: "kind" as const, key })),
          on: false,
        });
      }

      const preferences = await repoOf(project.id, u.id).preferences();
      const rows = await Promise.all(ATTENTION_KINDS.map((outcome) => eventRow(project.id, events[outcome]!.id)));
      const expected = rows.filter((row) => mayNotify(preferences, row, 0n)).length;
      const actual = await repoOf(project.id, u.id).unreadCount();
      expect(actual).toBe(expected);
    }
  });
});
