import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { engagementItems, engagementReplyClaims } from "../../../src/server/db/schema/engagement";
import { and, eq } from "drizzle-orm";
import { runTick } from "../../../src/server/scheduler";
import { schedulerConfig } from "../../../src/server/scheduler/config";
import { runHousekeeping } from "../../../src/server/scheduler/housekeeping";
import { listInbox } from "../../../src/server/services/engagement/inbox";
import * as accounts from "../../../src/server/services/accounts";
import { forProject } from "../../../src/server/dal/scope";
import { getEnv } from "../../../src/server/env";
import { fakeSession } from "../../helpers/auth";
import { closeDb, testDb } from "../../helpers/db";
import { createProjectWithMembers } from "../../helpers/factories";
import { postsEnv } from "../../helpers/posts-env";

afterAll(async () => {
  await closeDb();
});

const RETENTION_DAYS = 90;
const OLD = new Date(Date.now() - (RETENTION_DAYS + 1) * 86_400_000);
const config = (overrides: Record<string, unknown> = {}) => schedulerConfig(getEnv(), overrides);

describe("engagement retention (FR-060, FR-061, SC-014)", () => {
  it("prunes an old item with no pending draft and no unresolved ambiguity, along with its drafts", async () => {
    const env = await postsEnv();
    const account = await env.account({});
    const { id: itemId } = await env.scope.engagementItems.insertIfAbsent({
      socialAccountId: account.id,
      providerKey: "mock",
      kind: "reply",
      externalId: "old-1",
      text: "This is old",
      authorDisplayName: "Ada",
      authorHandle: "ada",
      authorExternalId: "ada-1",
      authorUrl: null,
      authorIdentityStable: true,
      saidAt: OLD,
      ingestedAt: OLD,
      parentExternalId: null,
    });
    await env.scope.engagementDrafts.insert({ engagementItemId: itemId, socialAccountId: account.id, text: "A rejected answer", origin: "person" });
    await env.scope.engagementDrafts.update((await env.scope.engagementDrafts.listByItem(itemId))[0]!.id, {
      reviewState: "rejected",
      reviewedAt: OLD,
      reviewedByUserId: env.owner.id,
    });

    await runHousekeeping(config());

    expect(await env.scope.engagementItems.get(itemId)).toBeNull();
  });

  it("keeps an old item with a pending draft", async () => {
    const env = await postsEnv();
    const account = await env.account({});
    const { id: itemId } = await env.scope.engagementItems.insertIfAbsent({
      socialAccountId: account.id,
      providerKey: "mock",
      kind: "reply",
      externalId: "old-2",
      text: "This is old but waiting",
      authorDisplayName: "Bea",
      authorHandle: "bea",
      authorExternalId: "bea-1",
      authorUrl: null,
      authorIdentityStable: true,
      saidAt: OLD,
      ingestedAt: OLD,
      parentExternalId: null,
    });
    await env.scope.engagementDrafts.insert({ engagementItemId: itemId, socialAccountId: account.id, text: "A pending answer", origin: "person" });

    await runHousekeeping(config());

    expect(await env.scope.engagementItems.get(itemId)).not.toBeNull();
  });

  it("keeps an old item with an unresolved ambiguous send", async () => {
    const env = await postsEnv();
    const account = await env.account({});
    const { id: itemId } = await env.scope.engagementItems.insertIfAbsent({
      socialAccountId: account.id,
      providerKey: "mock",
      kind: "reply",
      externalId: "old-3",
      text: "This is old but ambiguous",
      authorDisplayName: "Cy",
      authorHandle: "cy",
      authorExternalId: "cy-1",
      authorUrl: null,
      authorIdentityStable: true,
      saidAt: OLD,
      ingestedAt: OLD,
      parentExternalId: null,
    });
    const draft = await env.scope.engagementDrafts.insert({ engagementItemId: itemId, socialAccountId: account.id, text: "An ambiguous answer", origin: "person" });
    await env.scope.engagementDrafts.update(draft.id, {
      reviewState: "approved",
      reviewedAt: OLD,
      reviewedByUserId: env.owner.id,
      sendState: "ambiguous",
    });

    await runHousekeeping(config());

    expect(await env.scope.engagementItems.get(itemId)).not.toBeNull();
  });

  it("prunes a withdrawn item regardless of age", async () => {
    const env = await postsEnv();
    const account = await env.account({});
    const recent = new Date();
    const { id: itemId } = await env.scope.engagementItems.insertIfAbsent({
      socialAccountId: account.id,
      providerKey: "mock",
      kind: "reply",
      externalId: "withdrawn-1",
      text: "Taken down",
      authorDisplayName: "Dee",
      authorHandle: "dee",
      authorExternalId: "dee-1",
      authorUrl: null,
      authorIdentityStable: true,
      saidAt: recent,
      ingestedAt: recent,
      parentExternalId: null,
    });
    await env.scope.engagementItems.markWithdrawn(itemId, recent);

    await runHousekeeping(config());

    expect(await env.scope.engagementItems.get(itemId)).toBeNull();
  });

  it("never prunes the ledger", async () => {
    const env = await postsEnv();
    const account = await env.account({});
    const { id: itemId } = await env.scope.engagementItems.insertIfAbsent({
      socialAccountId: account.id,
      providerKey: "mock",
      kind: "reply",
      externalId: "ledger-1",
      text: "Already answered, long since",
      authorDisplayName: "Eve",
      authorHandle: "eve",
      authorExternalId: "eve-1",
      authorUrl: null,
      authorIdentityStable: true,
      saidAt: OLD,
      ingestedAt: OLD,
      parentExternalId: null,
    });
    await env.scope.engagementReplyClaims.insert({
      socialAccountId: account.id,
      itemExternalId: "ledger-1",
      generation: 1,
      draftId: randomUUID(),
      engagementItemId: itemId,
      approvedByUserId: env.owner.id,
      claimedAt: OLD,
    });

    await runHousekeeping(config());

    expect(await env.scope.engagementItems.get(itemId)).toBeNull();
    const claim = await testDb()
      .select()
      .from(engagementReplyClaims)
      .where(and(eq(engagementReplyClaims.projectId, env.project.id), eq(engagementReplyClaims.itemExternalId, "ledger-1")));
    expect(claim).toHaveLength(1);
  });

  it("a cursor restart does not resurrect a pruned item: ingest ignores anything older than the retention horizon", async () => {
    const ctx = await createProjectWithMembers();
    const scope = await forProject(fakeSession(ctx.owner.id), ctx.project.slug);
    const account = await accounts.connectMock(scope, {
      displayName: "Mock",
      settings: { engagementItems: [{ kind: "reply", externalId: "too-old", text: "Ancient", saidAt: OLD.toISOString() }] },
    });

    await runTick({ config: { engagementReadMinIntervalMs: 0, engagementRetentionDays: RETENTION_DAYS } });

    const list = await listInbox(scope);
    expect(list.items.map((i) => i.externalId)).not.toContain("too-old");
    const rows = await testDb()
      .select()
      .from(engagementItems)
      .where(and(eq(engagementItems.projectId, ctx.project.id), eq(engagementItems.socialAccountId, account.id)));
    expect(rows).toHaveLength(0);
  });
});
