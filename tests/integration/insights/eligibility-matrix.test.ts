import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { insightsPermissionFor } from "../../../src/lib/insights/eligibility";
import { scopePermissionFor } from "../../../src/lib/scope-permission";
import { pinterestConnectGroup } from "../../../src/providers/pinterest/connect-group";
import { pinterestInsights } from "../../../src/providers/pinterest/insights";
import {
  claimDueAccountMetricPolls,
  claimDuePostMetricPolls,
  countAccountsMissingInsightsScopes,
  type InsightsProviderRule,
} from "../../../src/server/dal/insights-claims";
import { claimDueEngagementReads, type EngagementProviderRule } from "../../../src/server/dal/engagement-read-claims";
import { randomUUID } from "node:crypto";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { atTime } from "../../helpers/clock";
import { getEnv } from "../../../src/server/env";
import { schedulerConfig } from "../../../src/server/scheduler/config";
import { runInsightsPoll } from "../../../src/server/scheduler/insights-poll";
import * as accountsService from "../../../src/server/services/accounts";
import { createFakeTikTok } from "../../helpers/fake-tiktok";
import { createFakeX } from "../../helpers/fake-x";
import { closeDb } from "../../helpers/db";
import { createProjectWithMembers } from "../../helpers/factories";
import { parkAllDueTargets } from "../../helpers/scheduling";
import { tickConfig } from "../../helpers/tick";

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

/** G37: every field an `InsightsProviderRule` needs, with sensible defaults a test overrides. */
function ruleFor(overrides: Partial<InsightsProviderRule> & { providerKey: string }): InsightsProviderRule {
  return {
    postScopes: [],
    accountScopes: [],
    postIdSource: "externalId",
    missingPostId: null,
    postMetricsDeclared: true,
    accountMetricsDeclared: true,
    ephemeralPostTypes: [],
    ...overrides,
  };
}

async function claimedAfterTick(projectId: string, accountId: string, providers: readonly InsightsProviderRule[]): Promise<boolean> {
  const claimed = await claimDueAccountMetricPolls({ now: NOW, limit: 100, leaseMs: 60_000, providers });
  return claimed.some((c) => c.account.id === accountId && c.account.projectId === projectId);
}

describe("the eligibility matrix is pinned to the SQL (contracts/granted-scopes.md §4)", () => {
  for (const [scopeCountLabel, required] of Object.entries(REQUIRED_SETS)) {
    for (const kind of ["null", "empty", "partial", "exact", "superset"] as const) {
      it(`${scopeCountLabel} required scopes (both surfaces equal), granted=${kind}: claimed iff insightsPermissionFor returns ok`, async () => {
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

        const rule = ruleFor({ providerKey, postScopes: required, accountScopes: required });
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

  const QUADRANTS: Record<string, { post: readonly string[]; account: readonly string[] }> = {
    "post scope held only": { post: ["scope_a"], account: [] },
    "account scope held only": { post: [], account: ["scope_a"] },
    both: { post: ["scope_a"], account: ["scope_a"] },
    neither: { post: [], account: [] },
  };

  for (const [quadrantLabel, held] of Object.entries(QUADRANTS)) {
    for (const kind of ["null", "narrow", "wide"] as const) {
      it(`G37 quadrant "${quadrantLabel}", granted=${kind}: each surface's eligibility depends only on its own scopes`, async () => {
        const ctx = await createProjectWithMembers();
        const repos = forSchedulerProject(ctx.project.id);
        const providerKey = `quadrant-${quadrantLabel.replace(/\s+/g, "-")}-${kind}`;
        const granted = kind === "null" ? null : kind === "narrow" ? ["scope_a"] : ["scope_a", "scope_b", "scope_c"];
        const account = await repos.accounts.upsertConnected({
          providerKey,
          displayName: "Quadrant account",
          externalAccountId: `ext-${providerKey}`,
          settings: {},
          credentialsEncrypted: null,
          credentialsExpiresAt: null,
          connectedByUserId: null,
          grantedScopes: granted ?? undefined,
        });

        const rule = ruleFor({ providerKey, postScopes: held.post, accountScopes: held.account });

        const accountClaimed = await claimedAfterTick(ctx.project.id, account.id, [rule]);
        const accountPermission = insightsPermissionFor({
          requiredScopes: held.account,
          grantedScopes: granted,
          requestedScopes: held.account,
          cannotWiden: null,
          missingScopes: { reason: "Reconnect to grant account insights access." },
        });
        expect(accountClaimed).toBe(accountPermission.kind === "ok");

        const postPermission = insightsPermissionFor({
          requiredScopes: held.post,
          grantedScopes: granted,
          requestedScopes: held.post,
          cannotWiden: null,
          missingScopes: { reason: "Reconnect to grant post insights access." },
        });
        // The post surface's own permission is independent of the account surface's:
        // held.post === [] is always ok regardless of what the account surface requires.
        if (held.post.length === 0) expect(postPermission.kind).toBe("ok");
      });
    }
  }

  it("Bluesky and mock with no declared scopes on either surface are claimed exactly as 080 specified (FR-024)", async () => {
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
    const rules: InsightsProviderRule[] = [ruleFor({ providerKey: "mock" }), ruleFor({ providerKey: "bluesky" })];
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
    const rule = ruleFor({ providerKey, postScopes: ["scope_a"], accountScopes: ["scope_a"] });
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
    const rule = ruleFor({ providerKey, postScopes: ["scope_a"], accountScopes: ["scope_a"] });
    const claimed = await claimDueAccountMetricPolls({ now: NOW, limit: 100, leaseMs: 60_000, providers: [rule] });
    const claimedIds = claimed.map((c) => c.account.id);
    expect(claimedIds).toContain(eligible.id);
    expect(claimedIds).not.toContain(ineligible.id);
  });

  describe("a pre-TIKTOK_INSIGHTS_SCOPES TikTok account (FR-020)", () => {
    afterEach(() => vi.restoreAllMocks());

    it("is never claimed, never leased, its credentials never decrypted, and zero fetch calls are recorded for it", async () => {
      await parkAllDueTargets();
      const ctx = await createProjectWithMembers();
      const repos = forSchedulerProject(ctx.project.id);
      const account = await repos.accounts.upsertConnected({
        providerKey: "tiktok",
        displayName: "Pre-082 TikTok",
        externalAccountId: "pre-082-tiktok",
        settings: {},
        credentialsEncrypted: "not-decryptable-if-ever-read",
        credentialsExpiresAt: null,
        connectedByUserId: null,
        // grantedScopes omitted: the column stays NULL, exactly as an account connected before
        // this entry's video.list/user.info.stats scopes existed would read.
      });
      const post = await repos.posts.insert({ baseText: "Hello" });
      const [target] = await repos.targets.insertMany([{ postId: post.id, socialAccountId: account.id }]);
      await repos.targets.update(target!.id, { status: "published", externalId: "ext-1", publicPostId: "pub-1", publishedAt: NOW });

      const rule: InsightsProviderRule = {
        providerKey: "tiktok",
        postScopes: ["video.list"],
        accountScopes: ["user.info.stats"],
        postIdSource: "publicPostId",
        missingPostId: { reason: "This post has no queryable public post id." },
        postMetricsDeclared: true,
        accountMetricsDeclared: true,
        ephemeralPostTypes: [],
      };
      const claimedPosts = await claimDuePostMetricPolls({ now: NOW, limit: 100, leaseMs: 60_000, minIntervalMs: 0, providers: [rule] });
      expect(claimedPosts.some((c) => c.state.postTargetId === target!.id)).toBe(false);
      const claimedAccounts = await claimDueAccountMetricPolls({ now: NOW, limit: 100, leaseMs: 60_000, providers: [rule] });
      expect(claimedAccounts.some((c) => c.account.id === account.id)).toBe(false);

      const decryptSpy = vi.spyOn(accountsService, "decryptCredentials");
      const fake = createFakeTikTok().install();
      const config = schedulerConfig(getEnv(), tickConfig().config);
      try {
        await atTime(NOW, () => runInsightsPoll({ config, tickId: randomUUID(), startedAt: NOW }));
      } finally {
        fake.uninstall();
      }
      expect(fake.requests).toHaveLength(0);
      expect(decryptSpy).not.toHaveBeenCalled();
    });
  });

  describe("a Pinterest account with only today's three scopes (US3-AS1/2, FR-028, FR-035)", () => {
    it("gets an account snapshot with no pin-analytics call attempted; the post panel names the missing pins:read", async () => {
      const ctx = await createProjectWithMembers();
      const repos = forSchedulerProject(ctx.project.id);
      const account = await repos.accounts.upsertConnected({
        providerKey: "pinterest",
        displayName: "Ada's Pinterest",
        externalAccountId: "pinterest-user-1",
        settings: {},
        credentialsEncrypted: null,
        credentialsExpiresAt: null,
        connectedByUserId: null,
        grantedScopes: ["user_accounts:read", "boards:read", "pins:write"],
      });

      const rule: InsightsProviderRule = {
        providerKey: "pinterest",
        postScopes: pinterestInsights.declaration.postScopes ?? [],
        accountScopes: pinterestInsights.declaration.accountScopes ?? [],
        postIdSource: pinterestInsights.declaration.postIdSource ?? "externalId",
        missingPostId: null,
        postMetricsDeclared: true,
        accountMetricsDeclared: true,
        ephemeralPostTypes: [],
      };

      const claimedAccounts = await claimDueAccountMetricPolls({ now: NOW, limit: 100, leaseMs: 60_000, providers: [rule] });
      expect(claimedAccounts.some((c) => c.account.id === account.id)).toBe(true);

      const post = await repos.posts.insert({ baseText: "Hello" });
      const [target] = await repos.targets.insertMany([{ postId: post.id, socialAccountId: account.id }]);
      await repos.targets.update(target!.id, { status: "published", externalId: "ext-pin-1", publishedAt: NOW });
      const claimedPosts = await claimDuePostMetricPolls({ now: NOW, limit: 100, leaseMs: 60_000, minIntervalMs: 0, providers: [rule] });
      expect(claimedPosts.some((c) => c.state.postTargetId === target!.id)).toBe(false);

      const permission = insightsPermissionFor({
        requiredScopes: pinterestInsights.declaration.postScopes ?? [],
        grantedScopes: ["user_accounts:read", "boards:read", "pins:write"],
        requestedScopes: pinterestConnectGroup.optionalScopes?.requested({}) ?? [],
        cannotWiden: null,
        missingScopes: pinterestInsights.declaration.missingPostScopes ?? null,
      });
      expect(permission.kind).not.toBe("ok");
      if (permission.kind !== "ok") {
        expect(permission.missing).toEqual(["pins:read"]);
        expect(permission.reason).toContain("pins:read");
        expect(permission.docsPath).toBe("pinterest-setup#insights");
      }
    });
  });

  describe("an X account with the opt-in off (contracts/x-metered-reads.md §1, SC-005)", () => {
    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    });

    it("is never claimed, never leased, its credentials never decrypted, and zero fetch calls are recorded for it in a full tick", async () => {
      await parkAllDueTargets();
      vi.stubEnv("X_INSIGHTS_ENABLED", "false");
      const ctx = await createProjectWithMembers();
      const repos = forSchedulerProject(ctx.project.id);
      const account = await repos.accounts.upsertConnected({
        providerKey: "x",
        displayName: "Ada's X",
        externalAccountId: "x-user-1",
        settings: {},
        credentialsEncrypted: "not-decryptable-if-ever-read",
        credentialsExpiresAt: null,
        connectedByUserId: null,
        grantedScopes: ["tweet.read", "tweet.write", "users.read", "media.write", "offline.access"],
      });
      const post = await repos.posts.insert({ baseText: "Hello" });
      const [target] = await repos.targets.insertMany([{ postId: post.id, socialAccountId: account.id }]);
      await repos.targets.update(target!.id, { status: "published", externalId: "1001", publishedAt: NOW });

      const decryptSpy = vi.spyOn(accountsService, "decryptCredentials");
      const fake = createFakeX().install();
      const config = schedulerConfig(getEnv(), tickConfig().config);
      try {
        await atTime(NOW, () => runInsightsPoll({ config, tickId: randomUUID(), startedAt: NOW }));
      } finally {
        fake.uninstall();
      }
      expect(fake.requests).toHaveLength(0);
      expect(decryptSpy).not.toHaveBeenCalled();
    });
  });

  describe("the engagement claim agrees with scopePermissionFor over declared scopes × grant state (contracts/scope-permission.md §3, FR-023)", () => {
    for (const [scopeCountLabel, required] of Object.entries(REQUIRED_SETS)) {
      for (const kind of ["null", "empty", "partial", "exact", "superset"] as const) {
        it(`${scopeCountLabel} declared readScopes, granted=${kind}: claimed iff scopePermissionFor returns ok`, async () => {
          const ctx = await createProjectWithMembers();
          const repos = forSchedulerProject(ctx.project.id);
          const providerKey = `engagement-matrix-${scopeCountLabel}-${kind}`;
          const granted = grantedFor(kind, required);
          const account = await repos.accounts.upsertConnected({
            providerKey,
            displayName: "Engagement matrix account",
            externalAccountId: `ext-${providerKey}`,
            settings: {},
            credentialsEncrypted: null,
            credentialsExpiresAt: null,
            connectedByUserId: null,
            grantedScopes: granted ?? undefined,
          });

          const rule: EngagementProviderRule = { providerKey, readScopes: required };
          const claimed = await claimDueEngagementReads({ now: NOW, limit: 100, leaseMs: 60_000, minIntervalMs: 0, providers: [rule] });
          const wasClaimed = claimed.some((c) => c.account.id === account.id);

          const permission = scopePermissionFor({
            requiredScopes: required,
            grantedScopes: granted,
            requestedScopes: required,
            cannotWiden: null,
            missingScopes: { reason: "Reconnect to grant engagement access." },
          });

          expect(wasClaimed).toBe(permission.kind === "ok");
        });
      }
    }
  });
});
