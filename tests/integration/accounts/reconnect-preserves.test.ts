import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../../src/server/db/client";
import { accountMetricPollStates, accountMetricSnapshots, socialAccounts } from "../../../src/server/db/schema";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { listConnectGroups } from "../../../src/providers/registry";
import { closeDb } from "../../helpers/db";
import { createProjectWithMembers } from "../../helpers/factories";

afterAll(closeDb);

const NOW = new Date("2026-03-01T00:00:00Z");

describe("reconnect preserves everything that keys off the account id (FR-014, SC-005, US2-AS3)", () => {
  for (const { group, providers } of listConnectGroups()) {
    it(`${group.key}: reconnecting the same external account updates in place`, async () => {
      const providerKey = providers[0]!.key;
      const ctx = await createProjectWithMembers();
      const repos = forSchedulerProject(ctx.project.id);

      const account = await repos.accounts.upsertConnected({
        providerKey,
        displayName: "Before reconnect",
        externalAccountId: "ext-account-1",
        settings: {},
        credentialsEncrypted: "cipher-1",
        credentialsExpiresAt: null,
        connectedByUserId: null,
        grantedScopes: ["some_scope"],
      });

      await repos.accounts.setLimit(account.id, { count: 3, windowSeconds: 3600 });
      await repos.accounts.setPostingInstructions(account.id, "Keep it short.");
      const slot = await repos.slots.insert(account.id, 1, "09:00");

      await getDb()
        .insert(accountMetricPollStates)
        .values({ socialAccountId: account.id, projectId: ctx.project.id, nextPollAt: NOW });
      await repos.accountMetricSnapshots.insertIfAbsent({
        socialAccountId: account.id,
        providerKey,
        capturedAt: NOW,
        metrics: { followerCount: 1 },
      });
      await repos.accountMetricSnapshots.insertIfAbsent({
        socialAccountId: account.id,
        providerKey,
        capturedAt: new Date(NOW.getTime() + 3_600_000),
        metrics: { followerCount: 2 },
      });

      const reconnected = await repos.accounts.upsertConnected({
        providerKey,
        displayName: "After reconnect",
        externalAccountId: "ext-account-1",
        settings: {},
        credentialsEncrypted: "cipher-2",
        credentialsExpiresAt: null,
        connectedByUserId: null,
        grantedScopes: ["some_scope", "another_scope"],
      });

      expect(reconnected.id).toBe(account.id);

      const rows = await getDb()
        .select()
        .from(socialAccounts)
        .where(
          and(
            eq(socialAccounts.projectId, ctx.project.id),
            eq(socialAccounts.providerKey, providerKey),
            eq(socialAccounts.externalAccountId, "ext-account-1"),
          ),
        );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(account.id);
      expect(rows[0]!.publishLimitCount).toBe(3);
      expect(rows[0]!.publishLimitWindowSeconds).toBe(3600);
      expect(rows[0]!.postingInstructions).toBe("Keep it short.");
      expect(rows[0]!.createdAt).toEqual(account.createdAt);
      expect(rows[0]!.removedAt).toBeNull();

      const slots = await repos.slots.listForAccount(account.id);
      expect(slots.map((s) => s.id)).toEqual([slot.id]);

      const pollState = await repos.accountMetricPollStates.get(account.id);
      expect(pollState).not.toBeNull();

      const snapshots = await repos.accountMetricSnapshots.countForAccountSince(account.id, new Date(0));
      expect(snapshots).toBe(2);
    });
  }

  it("the same Page connected twice in a row updates in place, not twice", async () => {
    const ctx = await createProjectWithMembers();
    const repos = forSchedulerProject(ctx.project.id);
    const first = await repos.accounts.upsertConnected({
      providerKey: "mock",
      displayName: "Page",
      externalAccountId: "page-1",
      settings: {},
      credentialsEncrypted: null,
      credentialsExpiresAt: null,
      connectedByUserId: null,
    });
    const second = await repos.accounts.upsertConnected({
      providerKey: "mock",
      displayName: "Page again",
      externalAccountId: "page-1",
      settings: {},
      credentialsEncrypted: null,
      credentialsExpiresAt: null,
      connectedByUserId: null,
    });
    expect(second.id).toBe(first.id);
    const rows = await getDb()
      .select()
      .from(socialAccounts)
      .where(and(eq(socialAccounts.projectId, ctx.project.id), eq(socialAccounts.externalAccountId, "page-1")));
    expect(rows).toHaveLength(1);
  });

  it("a removed-then-reconnected account gets a new row because the unique index is partial on removed_at IS NULL", async () => {
    const ctx = await createProjectWithMembers();
    const repos = forSchedulerProject(ctx.project.id);
    const first = await repos.accounts.upsertConnected({
      providerKey: "mock",
      displayName: "Removable",
      externalAccountId: "removable-1",
      settings: {},
      credentialsEncrypted: null,
      credentialsExpiresAt: null,
      connectedByUserId: null,
    });
    await repos.accounts.markRemoved(first.id, NOW);

    const reconnected = await repos.accounts.upsertConnected({
      providerKey: "mock",
      displayName: "Removable",
      externalAccountId: "removable-1",
      settings: {},
      credentialsEncrypted: null,
      credentialsExpiresAt: null,
      connectedByUserId: null,
    });

    expect(reconnected.id).not.toBe(first.id);
    const rows = await getDb()
      .select()
      .from(socialAccounts)
      .where(and(eq(socialAccounts.projectId, ctx.project.id), eq(socialAccounts.externalAccountId, "removable-1")));
    expect(rows).toHaveLength(2);
    const live = rows.filter((r) => r.removedAt === null);
    expect(live).toHaveLength(1);
    expect(live[0]!.id).toBe(reconnected.id);
  });
});
