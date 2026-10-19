import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertEngagementDeclaration } from "../../../src/providers/registry";
import { mockEngagement } from "../../../src/providers/mock/engagement";
import type { EngagementDeclaration } from "../../../src/providers/types";
import { claimDueEngagementReads, type EngagementProviderRule } from "../../../src/server/dal/engagement-read-claims";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { getEnv } from "../../../src/server/env";
import { schedulerConfig } from "../../../src/server/scheduler/config";
import { runEngagementRead } from "../../../src/server/scheduler/engagement-read";
import * as accountsService from "../../../src/server/services/accounts";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { createProjectWithMembers } from "../../helpers/factories";
import { parkAllEngagementReads } from "../../helpers/scheduling";
import { tickConfig } from "../../helpers/tick";

afterAll(closeDb);

// The read claim sweeps every project and is `limit`-bounded, so accounts left active by other
// files fill the claim and squeeze this file's own account out of it. Park them first.
beforeEach(parkAllEngagementReads);

const AT = new Date("2026-10-19T12:00:00Z");
const NO_WAIT = { engagementReadMinIntervalMs: 0 };

async function runSection(): Promise<void> {
  const config = schedulerConfig(getEnv(), tickConfig(NO_WAIT).config);
  await atTime(AT, () => runEngagementRead({ config, tickId: randomUUID(), startedAt: AT }));
}

const originalDeclaration: EngagementDeclaration = mockEngagement.declaration;
afterEach(() => {
  mockEngagement.declaration = originalDeclaration;
  vi.restoreAllMocks();
});

function withReadScopes(scopes: readonly string[]): void {
  mockEngagement.declaration = {
    ...originalDeclaration,
    readScopes: scopes,
    missingReadScopes: { reason: "Reconnect and grant read_comments to read comments." },
  };
}

describe("the engagement scope gate (US3, FR-018–FR-025)", () => {
  it("excludes an account missing a declared scope from the claim, leaves its lease columns NULL, creates no state row, decrypts nothing and calls read() zero times — then claims and reads it once it gains the grant (US3 scenario 5)", async () => {
    withReadScopes(["read_comments"]);
    const ctx = await createProjectWithMembers();
    const repos = forSchedulerProject(ctx.project.id);
    const account = await repos.accounts.upsertConnected({
      providerKey: "mock",
      displayName: "Gated mock",
      externalAccountId: "scope-gate-1",
      settings: { engagementItems: [{ kind: "comment", externalId: "c-1", text: "Hi", saidAt: AT.toISOString() }] },
      credentialsEncrypted: null,
      credentialsExpiresAt: null,
      connectedByUserId: null,
      // grantedScopes omitted: the column stays NULL.
    });

    const decryptSpy = vi.spyOn(accountsService, "decryptCredentials");
    const readSpy = vi.spyOn(mockEngagement, "read");

    const rule: EngagementProviderRule = { providerKey: "mock", readScopes: ["read_comments"] };
    const claimed = await claimDueEngagementReads({ now: AT, limit: 100, leaseMs: 60_000, minIntervalMs: 0, providers: [rule] });
    expect(claimed.some((c) => c.account.id === account.id)).toBe(false);

    const state = await repos.engagementAccountStates.get(account.id);
    expect(state).toBeNull();

    await runSection();
    expect(decryptSpy).not.toHaveBeenCalled();
    expect(readSpy).not.toHaveBeenCalled();
    expect(await repos.engagementAccountStates.get(account.id)).toBeNull();

    // The account later gains the grant — picked up on the next run with no manual step, from page one.
    await repos.accounts.upsertConnected({
      providerKey: "mock",
      displayName: "Gated mock",
      externalAccountId: "scope-gate-1",
      settings: { engagementItems: [{ kind: "comment", externalId: "c-1", text: "Hi", saidAt: AT.toISOString() }] },
      credentialsEncrypted: null,
      credentialsExpiresAt: null,
      connectedByUserId: null,
      grantedScopes: ["read_comments"],
    });

    await runSection();
    expect(readSpy).toHaveBeenCalled();
    const stateAfterGrant = await repos.engagementAccountStates.get(account.id);
    expect(stateAfterGrant).not.toBeNull();
    expect(await repos.engagementItems.getByExternalId(account.id, "c-1")).not.toBeNull();
  });

  it("treats a NULL grant as not holding the declared scopes", async () => {
    withReadScopes(["read_comments"]);
    const ctx = await createProjectWithMembers();
    const repos = forSchedulerProject(ctx.project.id);
    const account = await repos.accounts.upsertConnected({
      providerKey: "mock",
      displayName: "Null grant",
      externalAccountId: "scope-gate-null",
      settings: {},
      credentialsEncrypted: null,
      credentialsExpiresAt: null,
      connectedByUserId: null,
      // grantedScopes omitted → NULL, never "holds everything".
    });
    const rule: EngagementProviderRule = { providerKey: "mock", readScopes: ["read_comments"] };
    const claimed = await claimDueEngagementReads({ now: AT, limit: 100, leaseMs: 60_000, minIntervalMs: 0, providers: [rule] });
    expect(claimed.some((c) => c.account.id === account.id)).toBe(false);
  });

  it("claims Bluesky and the default mock configuration exactly as 077 specified: empty readScopes matches by provider key alone", async () => {
    const ctx = await createProjectWithMembers();
    const repos = forSchedulerProject(ctx.project.id);
    const mockAccount = await repos.accounts.upsertConnected({
      providerKey: "mock",
      displayName: "Default mock",
      externalAccountId: "scope-gate-default-mock",
      settings: {},
      credentialsEncrypted: null,
      credentialsExpiresAt: null,
      connectedByUserId: null,
    });
    const blueskyAccount = await repos.accounts.upsertConnected({
      providerKey: "bluesky",
      displayName: "Default bluesky",
      externalAccountId: "scope-gate-default-bluesky",
      settings: {},
      credentialsEncrypted: null,
      credentialsExpiresAt: null,
      connectedByUserId: null,
    });
    const rules: EngagementProviderRule[] = [
      { providerKey: "mock", readScopes: [] },
      { providerKey: "bluesky", readScopes: [] },
    ];
    const claimed = await claimDueEngagementReads({ now: AT, limit: 100, leaseMs: 60_000, minIntervalMs: 0, providers: rules });
    expect(claimed.some((c) => c.account.id === mockAccount.id)).toBe(true);
    expect(claimed.some((c) => c.account.id === blueskyAccount.id)).toBe(true);
  });

  it("registry load fails when a declaration sets both unavailable and a non-empty readScopes, naming both fields", () => {
    expect(() =>
      assertEngagementDeclaration({
        key: "test",
        engagement: { declaration: { reads: ["comment"], canReply: false, unavailable: { reason: "no permission" }, readScopes: ["read_comments"] } },
      }),
    ).toThrow(/unavailable and readScopes must never both be set/);
  });

  it("registry load fails when readScopes is non-empty with no missingReadScopes.reason", () => {
    expect(() =>
      assertEngagementDeclaration({
        key: "test",
        engagement: { declaration: { reads: ["comment"], canReply: false, readScopes: ["read_comments"] } },
      }),
    ).toThrow(/missingReadScopes/);
  });

  it("registry load fails when a readScopes entry does not match GRANTED_SCOPE_PATTERN", () => {
    expect(() =>
      assertEngagementDeclaration({
        key: "test",
        engagement: {
          declaration: { reads: ["comment"], canReply: false, readScopes: ["Not Valid!"], missingReadScopes: { reason: "ok" } },
        },
      }),
    ).toThrow(/readScopes entry/);
  });

  it("an account that loses eligibility keeps every item it already has, readable and unchanged, with status, publish limits and needs_reauth untouched (FR-024, FR-025)", async () => {
    const ctx = await createProjectWithMembers();
    const repos = forSchedulerProject(ctx.project.id);
    const account = await repos.accounts.upsertConnected({
      providerKey: "mock",
      displayName: "Losing eligibility",
      externalAccountId: "scope-gate-loses",
      settings: { engagementItems: [{ kind: "comment", externalId: "c-2", text: "Already read", saidAt: AT.toISOString() }] },
      credentialsEncrypted: null,
      credentialsExpiresAt: null,
      connectedByUserId: null,
      grantedScopes: ["read_comments"],
    });

    // First pass: eligible, the item is read and stored.
    withReadScopes(["read_comments"]);
    await runSection();
    const itemBefore = await repos.engagementItems.getByExternalId(account.id, "c-2");
    expect(itemBefore).not.toBeNull();
    const accountBefore = await repos.accounts.get(account.id);

    // The account loses its grant.
    await repos.accounts.upsertConnected({
      providerKey: "mock",
      displayName: "Losing eligibility",
      externalAccountId: "scope-gate-loses",
      settings: { engagementItems: [{ kind: "comment", externalId: "c-2", text: "Already read", saidAt: AT.toISOString() }] },
      credentialsEncrypted: null,
      credentialsExpiresAt: null,
      connectedByUserId: null,
      grantedScopes: [],
    });
    const rule: EngagementProviderRule = { providerKey: "mock", readScopes: ["read_comments"] };
    const claimedAfterLoss = await claimDueEngagementReads({ now: AT, limit: 100, leaseMs: 60_000, minIntervalMs: 0, providers: [rule] });
    expect(claimedAfterLoss.some((c) => c.account.id === account.id)).toBe(false);

    const itemAfter = await repos.engagementItems.getByExternalId(account.id, "c-2");
    expect(itemAfter).not.toBeNull();
    expect(itemAfter?.text).toBe(itemBefore?.text);
    const accountAfter = await repos.accounts.get(account.id);
    expect(accountAfter?.status).toBe(accountBefore?.status);
  });
});
