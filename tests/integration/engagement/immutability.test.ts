import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createEngagementItemsRepo } from "../../../src/server/dal/engagement";
import { socialAccounts } from "../../../src/server/db/schema/accounts";
import { engagementDrafts, engagementItems } from "../../../src/server/db/schema/engagement";
import { closeDb, testDb } from "../../helpers/db";
import { createProject } from "../../helpers/factories";

afterAll(async () => {
  await closeDb();
});

async function seedAccount(projectId: string): Promise<string> {
  const [row] = await testDb()
    .insert(socialAccounts)
    .values({ projectId, providerKey: "bluesky", displayName: "Bluesky account", externalAccountId: randomUUID() })
    .returning({ id: socialAccounts.id });
  return row!.id;
}

describe("engagement item immutability (FR-009, FR-010)", () => {
  it("re-ingesting the same (project, account, external id) with different text stores nothing new", async () => {
    const project = await createProject({ name: "Immutable" });
    const socialAccountId = await seedAccount(project.id);
    const repo = createEngagementItemsRepo(testDb(), project.id);
    const saidAt = new Date("2026-10-01T12:00:00.000Z");

    const first = await repo.insertIfAbsent({
      socialAccountId,
      providerKey: "bluesky",
      kind: "reply",
      externalId: "ext-1",
      text: "Original text",
      authorDisplayName: "Ada",
      authorHandle: "ada.bsky.social",
      authorExternalId: "did:plc:ada",
      authorUrl: null,
      authorIdentityStable: true,
      saidAt,
      ingestedAt: new Date("2026-10-01T12:00:05.000Z"),
      parentExternalId: "parent-1",
    });
    expect(first.inserted).toBe(true);

    const before = await repo.get(first.id);
    expect(before).not.toBeNull();

    const second = await repo.insertIfAbsent({
      socialAccountId,
      providerKey: "bluesky",
      kind: "reply",
      externalId: "ext-1",
      text: "Edited text, different author",
      authorDisplayName: "Someone Else",
      authorHandle: "else.bsky.social",
      authorExternalId: "did:plc:else",
      authorUrl: null,
      authorIdentityStable: true,
      saidAt,
      ingestedAt: new Date("2026-10-01T13:00:00.000Z"),
      parentExternalId: "parent-1",
    });
    expect(second.inserted).toBe(false);
    expect(second.id).toBe(first.id);

    const after = await repo.get(first.id);
    expect(after).toEqual(before);

    const itemRows = await testDb()
      .select()
      .from(engagementItems)
      .where(
        and(
          eq(engagementItems.projectId, project.id),
          eq(engagementItems.socialAccountId, socialAccountId),
          eq(engagementItems.externalId, "ext-1"),
        ),
      );
    expect(itemRows).toHaveLength(1);

    const draftRows = await testDb()
      .select()
      .from(engagementDrafts)
      .where(and(eq(engagementDrafts.projectId, project.id), eq(engagementDrafts.engagementItemId, first.id)));
    expect(draftRows).toHaveLength(0);
  });
});
