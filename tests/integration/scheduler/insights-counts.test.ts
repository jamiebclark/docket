import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../../src/server/db/client";
import { postMetricPollStates } from "../../../src/server/db/schema";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { readHeartbeats } from "../../../src/server/dal/heartbeats";
import { mockProvider } from "../../../src/providers/mock";
import type { PostType, SocialProvider } from "../../../src/providers/types";
import { runTick } from "../../../src/server/scheduler";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { createProjectWithMembers } from "../../helpers/factories";
import { registerTestProvider } from "../../helpers/provider-fixtures";
import { createMockAccount, parkAllDueTargets } from "../../helpers/scheduling";
import { tickConfig } from "../../helpers/tick";

afterAll(closeDb);
beforeEach(parkAllDueTargets);

const NOW = new Date("2026-07-01T00:00:00Z");
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
// Short enough that a single capture's next candidate (+1h past it) already crosses the lifetime
// boundary, so "expired" is reached after exactly one successful call, not the three ticks
// ephemeral.test.ts uses to exercise the dense cadence end to end.
const LIFETIME_MS = 1.5 * HOUR_MS;

// Stands in for a real Instagram account (contracts/provider-insights-081.md §1): a required-scopes
// gate without depending on Phase 6's reader (US7-AS1).
const REQUIRED = ["counts_required_scope"];
const gatedProvider: SocialProvider = {
  ...mockProvider,
  key: "insights-counts-gated",
  displayName: "Gated (test)",
  insights: {
    ...mockProvider.insights!,
    declaration: { ...mockProvider.insights!.declaration, postScopes: REQUIRED, missingPostScopes: { reason: "Reconnect to grant insights access." } },
  },
} as SocialProvider;
registerTestProvider(gatedProvider);

// Stands in for a TikTok-like reader (G35): post metrics keyed off publicPostId, so a target
// published without that column back-filled is skipped rather than claimed (FR-053).
const publicIdProvider: SocialProvider = {
  ...mockProvider,
  key: "insights-counts-public-id",
  displayName: "Public-id reader (test)",
  insights: {
    ...mockProvider.insights!,
    declaration: { ...mockProvider.insights!.declaration, postIdSource: "publicPostId", missingPostId: { reason: "No public post id yet." } },
  },
} as SocialProvider;
registerTestProvider(publicIdProvider);

// Declares both post and account scopes so a single ungranted account should still only be
// counted once by accountsSkippedNoPermission, not once per surface (FR-053).
const BOTH_SURFACES = ["counts_both_post_scope"];
const BOTH_SURFACES_ACCOUNT = ["counts_both_account_scope"];
const gatedBothSurfacesProvider: SocialProvider = {
  ...mockProvider,
  key: "insights-counts-gated-both",
  displayName: "Gated both surfaces (test)",
  insights: {
    ...mockProvider.insights!,
    declaration: {
      ...mockProvider.insights!.declaration,
      postScopes: BOTH_SURFACES,
      accountScopes: BOTH_SURFACES_ACCOUNT,
      missingPostScopes: { reason: "Reconnect to grant insights access." },
      missingAccountScopes: { reason: "Reconnect to grant insights access." },
    },
  },
} as SocialProvider;
registerTestProvider(gatedBothSurfacesProvider);

// Stands in for a story-like ephemeral surface (US7-AS2), local to this file so its fixtures don't
// interact with ephemeral.test.ts's own account/provider.
const storyProvider: SocialProvider = {
  ...mockProvider,
  key: "insights-counts-story",
  displayName: "Mock with stories (counts)",
  capabilities: { ...mockProvider.capabilities, postTypes: [...mockProvider.capabilities.postTypes, "story"] },
  insights: {
    ...mockProvider.insights!,
    declaration: { ...mockProvider.insights!.declaration, ephemeralPostTypes: [{ postType: "story", lifetimeMs: LIFETIME_MS }] },
  },
} as SocialProvider;
registerTestProvider(storyProvider);

async function publishedTarget(
  projectId: string,
  accountId: string,
  opts: { externalId: string; publishedAt: Date; chosenPostType?: PostType | null },
) {
  const repos = forSchedulerProject(projectId);
  const post = await repos.posts.insert({ baseText: "Hello" });
  const [target] = await repos.targets.insertMany([{ postId: post.id, socialAccountId: accountId }]);
  await repos.targets.update(target!.id, {
    status: "published",
    externalId: opts.externalId,
    publishedAt: opts.publishedAt,
    chosenPostType: opts.chosenPostType ?? null,
  });
  return target!;
}

async function pollState(projectId: string, postTargetId: string) {
  const [state] = await getDb()
    .select()
    .from(postMetricPollStates)
    .where(and(eq(postMetricPollStates.projectId, projectId), eq(postMetricPollStates.postTargetId, postTargetId)));
  return state;
}

describe("the counts the panel reads (contracts/scheduler-insights-081.md §2, §3, §4)", () => {
  it("an account whose grant does not cover a gated provider's required scopes is counted accountsSkippedNoPermission, never as a failure (US7-AS1)", async () => {
    const ctx = await createProjectWithMembers();
    const repos = forSchedulerProject(ctx.project.id);
    await repos.accounts.upsertConnected({
      providerKey: gatedProvider.key,
      displayName: "Ungranted",
      externalAccountId: "counts-ungranted",
      settings: {},
      credentialsEncrypted: null,
      credentialsExpiresAt: null,
      connectedByUserId: null,
      grantedScopes: [],
    });

    const summary = await atTime(NOW, () => runTick(tickConfig()));
    expect(summary.insightsPoll.counts.accountsSkippedNoPermission).toBeGreaterThanOrEqual(1);
    expect(summary.insightsPoll.counts.failed).toBe(0);
    expect(summary.insightsPoll.counts.credentialsInvalid).toBe(0);
  });

  it("a target whose provider keys post metrics off publicPostId is counted targetsSkippedNoPublicPostId, distinct from targetsSkippedNoExternalId and from a failure (FR-053)", async () => {
    const ctx = await createProjectWithMembers();
    const account = await createMockAccount(ctx.project.id, {}, { providerKey: publicIdProvider.key });
    await publishedTarget(ctx.project.id, account.id, { externalId: "counts-no-public-id-1", publishedAt: NOW });

    // `targetsSkippedNoExternalId` is a cross-project count (the tick is scheduler-wide), so a
    // worker's database carries whatever other files left behind. Asserting a global zero here
    // tests their isolation, not this behaviour. The property that matters is that THIS target —
    // which has an external id and lacks only the public post id — moves the publicPostId counter
    // and not the other one, so measure the delta across creating it.
    const before = await atTime(NOW, () => runTick(tickConfig()));
    await publishedTarget(ctx.project.id, account.id, { externalId: "counts-no-public-id-2", publishedAt: NOW });

    const summary = await atTime(new Date(NOW.getTime() + HOUR_MS), () => runTick(tickConfig()));
    expect(summary.insightsPoll.counts.targetsSkippedNoPublicPostId).toBeGreaterThanOrEqual(1);
    expect(summary.insightsPoll.counts.targetsSkippedNoExternalId).toBe(before.insightsPoll.counts.targetsSkippedNoExternalId);
    expect(summary.insightsPoll.counts.failed).toBe(0);
  });

  it("an account missing both a post-surface and an account-surface scope is counted accountsSkippedNoPermission exactly once (FR-053)", async () => {
    const ctx = await createProjectWithMembers();
    const repos = forSchedulerProject(ctx.project.id);
    await repos.accounts.upsertConnected({
      providerKey: gatedBothSurfacesProvider.key,
      displayName: "Ungranted both",
      externalAccountId: "counts-ungranted-both",
      settings: {},
      credentialsEncrypted: null,
      credentialsExpiresAt: null,
      connectedByUserId: null,
      grantedScopes: [],
    });

    const before = await atTime(NOW, () => runTick(tickConfig()));
    const baseline = before.insightsPoll.counts.accountsSkippedNoPermission;

    const ctx2 = await createProjectWithMembers();
    const repos2 = forSchedulerProject(ctx2.project.id);
    await repos2.accounts.upsertConnected({
      providerKey: gatedBothSurfacesProvider.key,
      displayName: "Ungranted both 2",
      externalAccountId: "counts-ungranted-both-2",
      settings: {},
      credentialsEncrypted: null,
      credentialsExpiresAt: null,
      connectedByUserId: null,
      grantedScopes: [],
    });
    const after = await atTime(NOW, () => runTick(tickConfig()));
    expect(after.insightsPoll.counts.accountsSkippedNoPermission).toBe(baseline + 1);
  });

  it("a target frozen expired and another frozen settled are each counted under their own reason, both under targetsFrozen (US7-AS2)", async () => {
    const ctx = await createProjectWithMembers();
    const storyAccount = await createMockAccount(ctx.project.id, {}, { providerKey: storyProvider.key });
    const storyTarget = await publishedTarget(ctx.project.id, storyAccount.id, {
      externalId: "counts-story-1",
      publishedAt: NOW,
      chosenPostType: "story",
    });

    const settledAccount = await createMockAccount(ctx.project.id);
    const settledTarget = await publishedTarget(ctx.project.id, settledAccount.id, {
      externalId: "counts-settled",
      publishedAt: new Date(NOW.getTime() - 28 * DAY_MS - HOUR_MS),
    });

    const summary = await atTime(new Date(NOW.getTime() + HOUR_MS), () => runTick(tickConfig()));
    expect(summary.insightsPoll.counts.targetsFrozenExpired).toBeGreaterThanOrEqual(1);
    expect(summary.insightsPoll.counts.targetsFrozenSettled).toBeGreaterThanOrEqual(1);
    expect(summary.insightsPoll.counts.targetsFrozen).toBeGreaterThanOrEqual(
      summary.insightsPoll.counts.targetsFrozenExpired + summary.insightsPoll.counts.targetsFrozenSettled,
    );

    const storyState = await pollState(ctx.project.id, storyTarget.id);
    expect(storyState?.frozenReason).toBe("expired");
    const settledState = await pollState(ctx.project.id, settledTarget.id);
    expect(settledState?.frozenReason).toBe("settled");
  });

  it("an id the provider classifies unqueryable is counted targetsUnqueryable, frozen, and clears any prior failure (US7-AS3)", async () => {
    const ctx = await createProjectWithMembers();
    const account = await createMockAccount(ctx.project.id, { insightsUnqueryableIds: ["counts-unqueryable-1"] });
    const target = await publishedTarget(ctx.project.id, account.id, { externalId: "counts-unqueryable-1", publishedAt: NOW });

    const summary = await atTime(new Date(NOW.getTime() + HOUR_MS), () => runTick(tickConfig()));
    expect(summary.insightsPoll.counts.targetsUnqueryable).toBeGreaterThanOrEqual(1);
    expect(summary.insightsPoll.counts.failed).toBe(0);

    const state = await pollState(ctx.project.id, target.id);
    expect(state?.frozenReason).toBe("unqueryable");
    expect(state?.nextPollAt).toBeNull();
    expect(state?.consecutiveFailures).toBe(0);
    expect(state?.lastError).toBeNull();
  });

  it("a repeated per-read unavailable backs off instead of being re-claimed on the next tick, and is not counted a failure (contracts/scheduler-insights-081.md §4)", async () => {
    const ctx = await createProjectWithMembers();
    const account = await createMockAccount(ctx.project.id, { insightsPostReadBehaviour: "unavailable" });
    const target = await publishedTarget(ctx.project.id, account.id, { externalId: "counts-unavailable-1", publishedAt: NOW });

    const first = await atTime(new Date(NOW.getTime() + HOUR_MS), () => runTick(tickConfig()));
    expect(first.insightsPoll.counts.unavailable).toBeGreaterThanOrEqual(1);
    expect(first.insightsPoll.counts.failed).toBe(0);

    const state = await pollState(ctx.project.id, target.id);
    expect(state?.nextPollAt).not.toBeNull();
    expect(state!.nextPollAt!.getTime()).toBeGreaterThan(NOW.getTime() + HOUR_MS);
    expect(state?.consecutiveFailures).toBe(0);

    const { mockInsights } = await import("../../../src/providers/mock/insights");
    const spy = vi.spyOn(mockInsights, "readPostMetrics");
    try {
      await atTime(new Date(NOW.getTime() + HOUR_MS + 1_000), () => runTick(tickConfig()));
      expect(spy.mock.calls.some((c) => c[0].posts.some((p) => p.externalId === "counts-unavailable-1"))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("a heartbeat is written on the out-of-budget path and matches the summary, distinguishable from nothing-to-do by outOfBudget > 0 with zero claims (US7-AS4, FR-050)", async () => {
    const ctx = await createProjectWithMembers();
    const account = await createMockAccount(ctx.project.id);
    await publishedTarget(ctx.project.id, account.id, { externalId: "counts-budget-1", publishedAt: NOW });

    const summary = await atTime(new Date(NOW.getTime() + HOUR_MS), () => runTick(tickConfig({ insightsTimeShare: 0 })));
    expect(summary.insightsPoll.ok).toBe(true);
    expect(summary.insightsPoll.counts.outOfBudget).toBeGreaterThanOrEqual(1);
    expect(summary.insightsPoll.counts.targetsClaimed).toBe(0);

    const heartbeats = await readHeartbeats();
    const hb = heartbeats.find((h) => h.section === "insights_poll");
    expect(hb).toBeDefined();
    expect(hb!.lastSummary).toEqual(summary.insightsPoll.counts);
  });

  it("a heartbeat is written on the normal path too, matching the summary (FR-050)", async () => {
    const ctx = await createProjectWithMembers();
    const account = await createMockAccount(ctx.project.id);
    await publishedTarget(ctx.project.id, account.id, { externalId: "counts-normal-1", publishedAt: NOW });

    const summary = await atTime(new Date(NOW.getTime() + HOUR_MS), () => runTick(tickConfig()));
    const heartbeats = await readHeartbeats();
    const hb = heartbeats.find((h) => h.section === "insights_poll");
    expect(hb).toBeDefined();
    expect(hb!.lastSummary).toEqual(summary.insightsPoll.counts);
  });
});
