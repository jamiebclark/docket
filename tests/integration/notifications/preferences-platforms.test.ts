import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { compileEligibility, mayNotify, preferencesOf } from "../../../src/lib/notifications/eligibility";
import { forMyProjects } from "../../../src/server/dal/my-projects";
import { createNotificationsRepo, platformClauseSql } from "../../../src/server/dal/notifications";
import { forProject } from "../../../src/server/dal/scope";
import { socialAccounts } from "../../../src/server/db/schema/accounts";
import { myNotificationPreferences, myPreferencesForProject, unreadSummary } from "../../../src/server/services/notifications";
import { closeDb, testDb } from "../../helpers/db";
import { addMember, createProject, createUser } from "../../helpers/factories";
import { recordEvent, startReading } from "../../helpers/notifications";

afterAll(async () => {
  await closeDb();
});

const repoOf = (projectId: string, userId: string) => createNotificationsRepo(testDb(), projectId, userId);
const setOf = (userId: string) => forMyProjects({ user: { id: userId } });
const count = async (userId: string) => (await unreadSummary(await setOf(userId))).count;

async function seedAccount(projectId: string, providerKey: string): Promise<string> {
  const [row] = await testDb()
    .insert(socialAccounts)
    .values({ projectId, providerKey, displayName: `${providerKey} account`, externalAccountId: randomUUID() })
    .returning({ id: socialAccounts.id });
  return row!.id;
}

async function removeAccount(projectId: string, id: string): Promise<void> {
  await testDb()
    .update(socialAccounts)
    .set({ removedAt: new Date() })
    .where(and(eq(socialAccounts.projectId, projectId), eq(socialAccounts.id, id)));
}

async function fixture() {
  const project = await createProject({ name: "Woodwork" });
  const u = await createUser();
  await addMember(project.id, u.id, "editor");
  await startReading(project.id, u.id);
  return { project, u };
}

describe("per-platform preferences (US2, FR-003, FR-019)", () => {
  it("one platform off vs. both on", async () => {
    const { project, u } = await fixture();
    await seedAccount(project.id, "facebook");
    await seedAccount(project.id, "tiktok");
    await recordEvent(project.id, "target_failed", { providerKey: "facebook", providerKeys: ["facebook"] });
    await recordEvent(project.id, "target_failed", { providerKey: "tiktok", providerKeys: ["tiktok"] });

    expect(await count(u.id)).toBe(2);

    await repoOf(project.id, u.id).setSwitches({ switches: [{ axis: "platform", key: "facebook" }], on: false });

    expect(await count(u.id)).toBe(1);
  });

  it("a platform switched off whose accounts are all later removed still excludes its historical events", async () => {
    const { project, u } = await fixture();
    const accountId = await seedAccount(project.id, "tiktok");
    await recordEvent(project.id, "target_failed", { providerKey: "tiktok", providerKeys: ["tiktok"] });
    await repoOf(project.id, u.id).setSwitches({ switches: [{ axis: "platform", key: "tiktok" }], on: false });
    expect(await count(u.id)).toBe(0);

    await removeAccount(project.id, accountId);

    const row = await myPreferencesForProject(await forProject({ user: { id: u.id } }, project.slug));
    expect(row.platforms).toEqual([{ axis: "platform", key: "tiktok", label: "TikTok", on: false }]);
    expect(await count(u.id)).toBe(0);
  });

  it("a platform with accounts and no switch is on by default", async () => {
    const { project, u } = await fixture();
    await seedAccount(project.id, "bluesky");
    await recordEvent(project.id, "target_failed", { providerKey: "bluesky", providerKeys: ["bluesky"] });

    expect(await count(u.id)).toBe(1);
    const row = await myPreferencesForProject(await forProject({ user: { id: u.id } }, project.slug));
    expect(row.platforms).toEqual([{ axis: "platform", key: "bluesky", label: "Bluesky", on: true }]);
  });

  it("a platform with neither an account nor a switch is absent from the controls, and comes on by default once an account connects", async () => {
    const { project, u } = await fixture();
    let row = await myPreferencesForProject(await forProject({ user: { id: u.id } }, project.slug));
    expect(row.platforms).toEqual([]);
    const grid = await myNotificationPreferences(await setOf(u.id));
    expect(grid.find((p) => p.slug === project.slug)!.platforms).toEqual([]);

    await seedAccount(project.id, "instagram");

    row = await myPreferencesForProject(await forProject({ user: { id: u.id } }, project.slug));
    expect(row.platforms).toEqual([{ axis: "platform", key: "instagram", label: "Instagram", on: true }]);
  });

  it("a connect failure spanning two platforms counts once with either platform on, and not at all with both off", async () => {
    const { project, u } = await fixture();
    await seedAccount(project.id, "facebook");
    await seedAccount(project.id, "instagram");
    await recordEvent(project.id, "account_connect_failed", {
      providerKey: null,
      providerKeys: ["facebook", "instagram"],
      actorUserId: u.id,
    });

    expect(await count(u.id)).toBe(1);

    await repoOf(project.id, u.id).setSwitches({ switches: [{ axis: "platform", key: "facebook" }], on: false });
    expect(await count(u.id)).toBe(1); // instagram is still on

    await repoOf(project.id, u.id).setSwitches({ switches: [{ axis: "platform", key: "instagram" }], on: false });
    expect(await count(u.id)).toBe(0); // both off
  });

  it("an event with no platform recorded is governed by its kind alone", async () => {
    const prefsAllOff = preferencesOf([
      { axis: "platform", switchKey: "facebook", onFromSeq: null },
      { axis: "platform", switchKey: "tiktok", onFromSeq: null },
    ]);
    expect(mayNotify(prefsAllOff, { outcome: "failed", providerKeys: [], seq: 1n }, 0n)).toBe(true);

    // The log's CHECK makes a zero-platform row unreachable, so the §4.3 SQL expression is asserted
    // directly against ARRAY[]::text[] instead.
    const plan = compileEligibility(prefsAllOff);
    const clause = platformClauseSql(plan.platforms, "ARRAY[]::text[]", "1::bigint");
    const result = await testDb().execute(sql`SELECT (1 = 1 ${clause}) AS passes`);
    expect((result.rows[0] as { passes: boolean }).passes).toBe(true);
  });
});
