import { afterAll, describe, expect, it } from "vitest";
import { insightsPermissionFor } from "../../../src/lib/insights/eligibility";
import {
  claimDueAccountMetricPolls,
  countAccountsMissingInsightsScopes,
  type InsightsProviderRule,
} from "../../../src/server/dal/insights-claims";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { closeDb } from "../../helpers/db";
import { createProjectWithMembers } from "../../helpers/factories";

afterAll(closeDb);

const NOW = new Date("2026-05-01T00:00:00Z");

const REQUIRED_SETS: Record<string, readonly string[]> = {
  "0": [],
  "1": ["scope_a"],
  "2": ["scope_a", "scope_b"],
};

function grantedFor(kind: "null" | "empty" | "partial" | "exact" | "superset", required: readonly string[]): string[] | null {
  switch (kind) {
    case "null":
      return null;
    case "empty":
      return [];
    case "partial":
      return required.slice(0, Math.max(0, required.length - 1));
    case "exact":
      return [...required];
    case "superset":
      return [...required, "extra_scope"];
  }
}

async function claimedAfterTick(projectId: string, accountId: string, providers: readonly InsightsProviderRule[]): Promise<boolean> {
  const claimed = await claimDueAccountMetricPolls({ now: NOW, limit: 100, leaseMs: 60_000, providers });
  return claimed.some((c) => c.account.id === accountId && c.account.projectId === projectId);
}

describe("the eligibility matrix is pinned to the SQL (contracts/granted-scopes.md §4)", () => {
  for (const [scopeCountLabel, required] of Object.entries(REQUIRED_SETS)) {
    for (const kind of ["null", "empty", "partial", "exact", "superset"] as const) {
      it(`${scopeCountLabel} required scopes, granted=${kind}: claimed iff insightsPermissionFor returns ok`, async () => {
        const ctx = await createProjectWithMembers();
        const repos = forSchedulerProject(ctx.project.id);
        const providerKey = `matrix-${scopeCountLabel}-${kind}`;
        const granted = grantedFor(kind, required);
        const account = await repos.accounts.upsertConnected({
          providerKey,
          displayName: "Matrix account",
          externalAccountId: `ext-${providerKey}`,
          settings: {},
          credentialsEncrypted: null,
          credentialsExpiresAt: null,
          connectedByUserId: null,
          grantedScopes: granted ?? undefined,
        });

        const rule: InsightsProviderRule = { providerKey, requiredScopes: required, ephemeralPostTypes: [] };
        const claimed = await claimedAfterTick(ctx.project.id, account.id, [rule]);

        const permission = insightsPermissionFor({
          requiredScopes: required,
          grantedScopes: granted,
          requestedScopes: required,
          cannotWiden: null,
          missingScopes: { reason: "Reconnect to grant insights access." },
        });

        expect(claimed).toBe(permission.kind === "ok");
      });
    }
  }

  it("Bluesky and mock with requiredScopes: [] are claimed exactly as 080 specified (FR-024)", async () => {
    const ctx = await createProjectWithMembers();
    const repos = forSchedulerProject(ctx.project.id);
    const mock = await repos.accounts.upsertConnected({
      providerKey: "mock",
      displayName: "Mock",
      externalAccountId: "mock-1",
      settings: {},
      credentialsEncrypted: null,
      credentialsExpiresAt: null,
      connectedByUserId: null,
    });
    const rules: InsightsProviderRule[] = [
      { providerKey: "mock", requiredScopes: [], ephemeralPostTypes: [] },
      { providerKey: "bluesky", requiredScopes: [], ephemeralPostTypes: [] },
    ];
    expect(await claimedAfterTick(ctx.project.id, mock.id, rules)).toBe(true);
  });

  it("countAccountsMissingInsightsScopes reports the ineligible accounts as its own count, never as a failure (US7-AS1)", async () => {
    const ctx = await createProjectWithMembers();
    const repos = forSchedulerProject(ctx.project.id);
    const providerKey = "matrix-count";
    await repos.accounts.upsertConnected({
      providerKey,
      displayName: "Eligible",
      externalAccountId: "count-eligible",
      settings: {},
      credentialsEncrypted: null,
      credentialsExpiresAt: null,
      connectedByUserId: null,
      grantedScopes: ["scope_a"],
    });
    await repos.accounts.upsertConnected({
      providerKey,
      displayName: "Ineligible",
      externalAccountId: "count-ineligible",
      settings: {},
      credentialsEncrypted: null,
      credentialsExpiresAt: null,
      connectedByUserId: null,
    });
    const rule: InsightsProviderRule = { providerKey, requiredScopes: ["scope_a"], ephemeralPostTypes: [] };
    await expect(countAccountsMissingInsightsScopes([rule])).resolves.toBe(1);
  });

  it("two accounts on one Meta login, one eligible and one not, produce one claimed account and one non-claim (US3-AS6)", async () => {
    const ctx = await createProjectWithMembers();
    const repos = forSchedulerProject(ctx.project.id);
    const providerKey = "matrix-login";
    const eligible = await repos.accounts.upsertConnected({
      providerKey,
      displayName: "Page",
      externalAccountId: "login-page",
      settings: {},
      credentialsEncrypted: null,
      credentialsExpiresAt: null,
      connectedByUserId: null,
      grantedScopes: ["scope_a"],
    });
    const ineligible = await repos.accounts.upsertConnected({
      providerKey,
      displayName: "Instagram",
      externalAccountId: "login-ig",
      settings: {},
      credentialsEncrypted: null,
      credentialsExpiresAt: null,
      connectedByUserId: null,
      grantedScopes: [],
    });
    const rule: InsightsProviderRule = { providerKey, requiredScopes: ["scope_a"], ephemeralPostTypes: [] };
    const claimed = await claimDueAccountMetricPolls({ now: NOW, limit: 100, leaseMs: 60_000, providers: [rule] });
    const claimedIds = claimed.map((c) => c.account.id);
    expect(claimedIds).toContain(eligible.id);
    expect(claimedIds).not.toContain(ineligible.id);
  });
});
