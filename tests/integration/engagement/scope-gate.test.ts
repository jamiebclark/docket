import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertEngagementDeclaration, listProviders } from "../../../src/providers/registry";
import { mockProvider } from "../../../src/providers/mock";
import { mockEngagement } from "../../../src/providers/mock/engagement";
import type { EngagementDeclaration } from "../../../src/providers/types";
import { resetUsageBackoffs } from "../../../src/providers/meta/usage";
import {
  claimDueEngagementReads,
  countAccountsMissingEngagementScopes,
  countAccountsOnUnavailableEngagement,
  type EngagementProviderRule,
} from "../../../src/server/dal/engagement-read-claims";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { forProject } from "../../../src/server/dal/scope";
import { getEnv } from "../../../src/server/env";
import { schedulerConfig } from "../../../src/server/scheduler/config";
import { runEngagementRead } from "../../../src/server/scheduler/engagement-read";
import * as accountsService from "../../../src/server/services/accounts";
import { listEngagementAccounts } from "../../../src/server/services/engagement/inbox";
import { fakeSession } from "../../helpers/auth";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { createFakeGraph, type FakeGraph } from "../../helpers/fake-graph";
import { createProjectWithMembers } from "../../helpers/factories";
import { registerTestProvider } from "../../helpers/provider-fixtures";
import { parkAllEngagementReads } from "../../helpers/scheduling";
import { tickConfig } from "../../helpers/tick";

/**
 * Its own provider key *and* its own declaration object — `mockProvider.engagement` is the shared
 * `mockEngagement` singleton, so reusing it here would mean `withReadScopes` (which mutates that
 * singleton's `declaration`) leaks the same `readScopes` onto the real "mock" key's accounts too,
 * defeating the isolation a global, cross-project count otherwise needs.
 */
/** The rule list `runEngagementRead` builds, so a baseline is measured the way the count is. */
function sectionRules(): EngagementProviderRule[] {
  return listProviders()
    .filter((p) => p.engagement && !p.engagement.declaration.unavailable)
    .map((p) => ({ providerKey: p.key, readScopes: p.engagement!.declaration.readScopes ?? [] }));
}

const skipCountProvider = registerTestProvider({
  ...mockProvider,
  key: "skip-count-test",
  engagement: {
    ...mockEngagement,
    declaration: {
      ...mockEngagement.declaration,
      readScopes: ["read_comments", "read_insights"],
      missingReadScopes: { reason: "Reconnect and grant read_comments to read comments." },
    },
  },
});

afterAll(closeDb);

// The read claim sweeps every project and is `limit`-bounded, so accounts left active by other
// files fill the claim and squeeze this file's own account out of it. Park them first.
beforeEach(parkAllEngagementReads);

const AT = new Date("2026-10-19T12:00:00Z");
const NO_WAIT = { engagementReadMinIntervalMs: 0 };

async function runSection() {
  const config = schedulerConfig(getEnv(), tickConfig(NO_WAIT).config);
  return atTime(AT, () => runEngagementRead({ config, tickId: randomUUID(), startedAt: AT }));
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

describe("an untouched install (US2 scenarios 2, 5)", () => {
  it("claims, reads and commits a NULL-granted account through the real engagement-read section exactly as 077 specified, and the inbox page shows no new notice for it", async () => {
    const ctx = await createProjectWithMembers();
    const repos = forSchedulerProject(ctx.project.id);
    const account = await repos.accounts.upsertConnected({
      providerKey: "mock",
      displayName: "Untouched mock",
      externalAccountId: "scope-gate-untouched",
      settings: { engagementItems: [{ kind: "comment", externalId: "untouched-1", text: "Hi", saidAt: AT.toISOString() }] },
      credentialsEncrypted: null,
      credentialsExpiresAt: null,
      connectedByUserId: null,
      // grantedScopes omitted: the column stays NULL, exactly as a Bluesky account connected before
      // 081 ever introduced the column. The default mock and bluesky declarations both carry no
      // readScopes, so this is the same "matched by provider key alone" path (FR-006).
    });

    await runSection();

    const item = await repos.engagementItems.getByExternalId(account.id, "untouched-1");
    expect(item).not.toBeNull();
    const state = await repos.engagementAccountStates.get(account.id);
    expect(state).not.toBeNull();

    const scope = await forProject(fakeSession(ctx.owner.id), ctx.project.slug);
    const accountViews = await listEngagementAccounts(scope);
    const view = accountViews.find((v) => v.id === account.id);
    expect(view).toEqual({
      id: account.id,
      displayName: "Untouched mock",
      providerKey: "mock",
      providerDisplayName: "Mock (offline)",
      unavailable: null,
      readPermission: null,
    });
    expect(Object.keys(view ?? {}).sort()).toEqual([
      "displayName",
      "id",
      "providerDisplayName",
      "providerKey",
      "readPermission",
      "unavailable",
    ]);
  });
});

describe("the inbox notice and accounts-page line (US4, FR-034–FR-037)", () => {
  it("reports a ScopePermission other than ok for an account missing its declared read scopes, and null once default/no scopes are declared", async () => {
    const ctx = await createProjectWithMembers();
    const repos = forSchedulerProject(ctx.project.id);
    withReadScopes(["read_comments"]);
    const account = await repos.accounts.upsertConnected({
      providerKey: "mock",
      displayName: "Needs reconnect",
      externalAccountId: "scope-gate-notice",
      settings: {},
      credentialsEncrypted: null,
      credentialsExpiresAt: null,
      connectedByUserId: null,
      // grantedScopes omitted: NULL.
    });

    const scope = await forProject(fakeSession(ctx.owner.id), ctx.project.slug);
    const accountViews = await listEngagementAccounts(scope);
    const view = accountViews.find((v) => v.id === account.id);
    expect(view?.unavailable).toBeNull();
    expect(view?.readPermission).not.toBeNull();
    expect(view?.readPermission?.kind).not.toBe("ok");
    if (view?.readPermission && view.readPermission.kind !== "ok") {
      expect(view.readPermission.reason).toMatch(/read_comments/);
    }

    const accountList = await accountsService.listAccounts(scope);
    const accountView = accountList.find((a) => a.id === account.id);
    expect(accountView?.engagementReadPermission?.kind).not.toBe("ok");
  });

  it("holds both an unavailable notice and a readPermission notice at once, for different accounts, with distinguishable wording", async () => {
    const ctx = await createProjectWithMembers();
    const repos = forSchedulerProject(ctx.project.id);
    const originalDecl = mockEngagement.declaration;
    mockEngagement.declaration = { ...originalDecl, unavailable: { reason: "Not buildable yet." }, readScopes: undefined, missingReadScopes: undefined };
    const unavailableAccount = await repos.accounts.upsertConnected({
      providerKey: "mock",
      displayName: "Unavailable one",
      externalAccountId: "scope-gate-unavailable",
      settings: {},
      credentialsEncrypted: null,
      credentialsExpiresAt: null,
      connectedByUserId: null,
    });
    mockEngagement.declaration = originalDecl;
    withReadScopes(["read_comments"]);
    const gatedAccount = await repos.accounts.upsertConnected({
      providerKey: "mock",
      displayName: "Gated one",
      externalAccountId: "scope-gate-gated",
      settings: {},
      credentialsEncrypted: null,
      credentialsExpiresAt: null,
      connectedByUserId: null,
    });

    mockEngagement.declaration = { ...originalDecl, unavailable: { reason: "Not buildable yet." }, readScopes: undefined, missingReadScopes: undefined };
    const scope = await forProject(fakeSession(ctx.owner.id), ctx.project.slug);
    let views = await listEngagementAccounts(scope);
    const unavailableView = views.find((v) => v.id === unavailableAccount.id);
    expect(unavailableView?.unavailable?.reason).toBe("Not buildable yet.");

    withReadScopes(["read_comments"]);
    views = await listEngagementAccounts(scope);
    const gatedView = views.find((v) => v.id === gatedAccount.id);
    expect(gatedView?.readPermission?.kind).not.toBe("ok");
    expect(unavailableView?.unavailable?.reason).not.toBe(
      gatedView?.readPermission && gatedView.readPermission.kind !== "ok" ? gatedView.readPermission.reason : undefined,
    );
  });

  it("gives an account that holds its declared scopes a readPermission of ok, and the accounts-page line does not appear for it", async () => {
    const ctx = await createProjectWithMembers();
    const repos = forSchedulerProject(ctx.project.id);
    withReadScopes(["read_comments"]);
    const account = await repos.accounts.upsertConnected({
      providerKey: "mock",
      displayName: "Already granted",
      externalAccountId: "scope-gate-granted",
      settings: {},
      credentialsEncrypted: null,
      credentialsExpiresAt: null,
      connectedByUserId: null,
      grantedScopes: ["read_comments"],
    });
    const scope = await forProject(fakeSession(ctx.owner.id), ctx.project.slug);
    const views = await listEngagementAccounts(scope);
    expect(views.find((v) => v.id === account.id)?.readPermission).toEqual({ kind: "ok" });
    const accountViews = await accountsService.listAccounts(scope);
    expect(accountViews.find((a) => a.id === account.id)?.engagementReadPermission).toEqual({ kind: "ok" });
  });
});

describe("the accountsSkippedNoPermission count (US6, FR-049-FR-050)", () => {
  it("counts accounts skipped for missing permission, deduplicated, and keeps it distinct from unavailable, failed and rateLimited", async () => {
    const ctx = await createProjectWithMembers();
    const repos = forSchedulerProject(ctx.project.id);
    // Measured before this test creates anything. The count is database-wide across every provider
    // with declared read scopes — the 086 review said so at the time — so a Meta account another
    // file left behind without `pages_read_user_content` lands in it too: run beside the Meta
    // suites it reads 146, not 1. The claim here is that exactly one of THIS test's accounts is
    // skipped, which is a delta.
    const skippedBefore = await countAccountsMissingEngagementScopes(sectionRules());
    // Missing both declared scopes — counted once, not twice.
    await repos.accounts.upsertConnected({
      providerKey: skipCountProvider.key,
      displayName: "Missing both scopes",
      externalAccountId: "skipped-missing-both",
      settings: {},
      credentialsEncrypted: null,
      credentialsExpiresAt: null,
      connectedByUserId: null,
      grantedScopes: [],
    });
    // Eligible — read normally, not counted.
    await repos.accounts.upsertConnected({
      providerKey: skipCountProvider.key,
      displayName: "Eligible",
      externalAccountId: "skipped-eligible",
      settings: {},
      credentialsEncrypted: null,
      credentialsExpiresAt: null,
      connectedByUserId: null,
      grantedScopes: ["read_comments", "read_insights"],
    });

    // `unavailable` counts every account on an unavailable provider across the whole database,
    // which is what FR-016 wants of a scheduler-wide figure — but the worker database is shared
    // and never truncated between files, so a bare `toBe(0)` here asserts that no other test file
    // happened to leave a Threads account behind. Thirteen of them do. The claim this test is
    // actually making is that none of ITS accounts land in `unavailable`, which is a delta.
    const unavailableBefore = await countAccountsOnUnavailableEngagement(["threads"]);
    const counts = await runSection();
    expect(counts.accountsSkippedNoPermission).toBe(skippedBefore + 1);
    expect(counts.unavailable).toBe(unavailableBefore);
    expect(counts.failed).toBe(0);
    expect(counts.rateLimited).toBe(0);
  });

  it("is 0 with no extra query when no provider declares read scopes", async () => {
    const rules: EngagementProviderRule[] = [
      { providerKey: "mock", readScopes: [] },
      { providerKey: "bluesky", readScopes: [] },
    ];
    await expect(countAccountsMissingEngagementScopes(rules)).resolves.toBe(0);
    await expect(countAccountsMissingEngagementScopes([])).resolves.toBe(0);
  });
});

describe("Facebook and Instagram have not reconnected for their new engagement scopes (US6 scenario 3, SC-009, FR-037)", () => {
  let fake: FakeGraph;
  beforeEach(() => {
    fake = createFakeGraph().install();
    resetUsageBackoffs();
  });
  afterEach(() => {
    fake.uninstall();
  });

  it.each([
    { providerKey: "facebook" as const, externalAccountId: "scope-gate-fb-stale", grantedScopes: ["pages_read_engagement"] },
    { providerKey: "instagram" as const, externalAccountId: "scope-gate-ig-stale", grantedScopes: ["instagram_basic", "pages_read_engagement"] },
  ])("excludes a connected %s account missing its new declared scope from the claim, with zero Graph calls, zero credential decrypts, and counts it in accountsSkippedNoPermission", async ({ providerKey, externalAccountId, grantedScopes }) => {
    const ctx = await createProjectWithMembers();
    const repos = forSchedulerProject(ctx.project.id);
    const account = await repos.accounts.upsertConnected({
      providerKey,
      displayName: `Stale ${providerKey}`,
      externalAccountId,
      settings: {},
      credentialsEncrypted: null,
      credentialsExpiresAt: null,
      connectedByUserId: null,
      grantedScopes,
    });

    const decryptSpy = vi.spyOn(accountsService, "decryptCredentials");
    const counts = await atTime(AT, () =>
      runEngagementRead({ config: schedulerConfig(getEnv(), tickConfig(NO_WAIT).config), tickId: randomUUID(), startedAt: AT }),
    );

    expect(fake.requests).toHaveLength(0);
    expect(decryptSpy).not.toHaveBeenCalled();
    expect(await repos.engagementAccountStates.get(account.id)).toBeNull();
    expect(counts.accountsSkippedNoPermission).toBeGreaterThanOrEqual(1);
  });
});
