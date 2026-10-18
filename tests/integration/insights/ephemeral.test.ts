import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../../src/server/db/client";
import { postMetricPollStates, postMetricSnapshots } from "../../../src/server/db/schema";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { mockProvider } from "../../../src/providers/mock";
import type { PostType, SocialProvider } from "../../../src/providers/types";
import { runTick } from "../../../src/server/scheduler";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { createProjectWithMembers } from "../../helpers/factories";
import { createMockAccount, parkAllDueTargets } from "../../helpers/scheduling";
import { registerTestProvider } from "../../helpers/provider-fixtures";
import { tickConfig } from "../../helpers/tick";

afterAll(closeDb);
beforeEach(parkAllDueTargets);

const NOW = new Date("2026-06-01T00:00:00Z");
const HOUR_MS = 3_600_000;
const LIFETIME_MS = 3 * HOUR_MS;

// A mock clone whose capabilities and insights declaration carry a "story" ephemeral post type, so
// the dense-cadence/expiry schedule can be driven end to end without a real Meta fixture
// (contracts/provider-insights-081.md §6).
const storyInsights = { ...mockProvider.insights! };
const storyProvider: SocialProvider = {
  ...mockProvider,
  key: "ephemeral-story-mock",
  displayName: "Mock with stories",
  capabilities: { ...mockProvider.capabilities, postTypes: [...mockProvider.capabilities.postTypes, "story"] },
  insights: {
    ...storyInsights,
    declaration: { ...storyInsights.declaration, ephemeralPostTypes: [{ postType: "story", lifetimeMs: LIFETIME_MS }] },
  },
} as SocialProvider;
registerTestProvider(storyProvider);

async function publishedTarget(projectId: string, accountId: string, opts: { externalId: string; publishedAt: Date; chosenPostType?: PostType | null }) {
  const repos = forSchedulerProject(projectId);
  const post = await repos.posts.insert({ baseText: "Story" });
  const [target] = await repos.targets.insertMany([{ postId: post.id, socialAccountId: accountId }]);
  await repos.targets.update(target!.id, {
    status: "published",
    externalId: opts.externalId,
    publishedAt: opts.publishedAt,
    chosenPostType: opts.chosenPostType === undefined ? "story" : opts.chosenPostType,
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

async function snapshotCount(projectId: string, postTargetId: string) {
  const rows = await getDb()
    .select()
    .from(postMetricSnapshots)
    .where(and(eq(postMetricSnapshots.projectId, projectId), eq(postMetricSnapshots.postTargetId, postTargetId)));
  return rows.length;
}

describe("a story is read while it exists, then frozen (US5, contracts/scheduler-insights-081.md §3)", () => {
  it("is read through its window on the dense cadence, never scheduled past the boundary, then frozen expired with zero calls after (SC-007, US5-AS1/2)", async () => {
    const ctx = await createProjectWithMembers();
    const account = await createMockAccount(ctx.project.id, {}, { providerKey: storyProvider.key });
    const target = await publishedTarget(ctx.project.id, account.id, { externalId: "story-1", publishedAt: NOW });

    const spy = vi.spyOn(storyProvider.insights!, "readPostMetrics");
    try {
      // The lazy insert runs on the first tick that sees the target; born due at
      // publishedAt + 1h (the dense first-band cadence, same as a non-ephemeral post).
      await atTime(NOW, () => runTick(tickConfig()));
      let state = await pollState(ctx.project.id, target.id);
      expect(state?.nextPollAt?.getTime()).toBe(NOW.getTime() + HOUR_MS);
      expect(await snapshotCount(ctx.project.id, target.id)).toBe(0);

      await atTime(new Date(NOW.getTime() + HOUR_MS), () => runTick(tickConfig()));
      expect(await snapshotCount(ctx.project.id, target.id)).toBe(1);
      state = await pollState(ctx.project.id, target.id);
      expect(state?.frozenAt).toBeNull();
      expect(state?.nextPollAt?.getTime()).toBe(NOW.getTime() + 2 * HOUR_MS);

      // The next capture lands at +2h; the following candidate (+3h) hits the lifetime boundary, so
      // the target is frozen expired instead of scheduled past it.
      await atTime(new Date(NOW.getTime() + 2 * HOUR_MS), () => runTick(tickConfig()));
      expect(await snapshotCount(ctx.project.id, target.id)).toBe(2);
      state = await pollState(ctx.project.id, target.id);
      expect(state?.nextPollAt).toBeNull();
      expect(state?.frozenReason).toBe("expired");
      expect(state?.frozenAt?.getTime()).toBe(NOW.getTime() + 2 * HOUR_MS);

      const callsAtFreeze = spy.mock.calls.length;
      await atTime(new Date(NOW.getTime() + 10 * HOUR_MS), () => runTick(tickConfig()));
      expect(spy.mock.calls.length).toBe(callsAtFreeze);
      expect(await snapshotCount(ctx.project.id, target.id)).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("a story already past its lifetime when first seen is born frozen, with no provider call and no catch-up capture (FR-041, US5-AS3)", async () => {
    const ctx = await createProjectWithMembers();
    const account = await createMockAccount(ctx.project.id, {}, { providerKey: storyProvider.key });
    const target = await publishedTarget(ctx.project.id, account.id, {
      externalId: "story-late",
      publishedAt: new Date(NOW.getTime() - 10 * HOUR_MS),
    });

    const spy = vi.spyOn(storyProvider.insights!, "readPostMetrics");
    try {
      await atTime(NOW, () => runTick(tickConfig()));
      expect(spy).not.toHaveBeenCalled();
      const state = await pollState(ctx.project.id, target.id);
      expect(state?.nextPollAt).toBeNull();
      expect(state?.frozenReason).toBe("expired");
      expect(await snapshotCount(ctx.project.id, target.id)).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("a non-ephemeral target on the same account follows 080's unchanged decaying schedule (US5-AS5)", async () => {
    const ctx = await createProjectWithMembers();
    const account = await createMockAccount(ctx.project.id, {}, { providerKey: storyProvider.key });
    const target = await publishedTarget(ctx.project.id, account.id, { externalId: "plain-1", publishedAt: NOW, chosenPostType: null });

    await atTime(NOW, () => runTick(tickConfig()));
    let state = await pollState(ctx.project.id, target.id);
    expect(state?.frozenAt).toBeNull();
    expect(state?.nextPollAt?.getTime()).toBe(NOW.getTime() + HOUR_MS);

    await atTime(new Date(NOW.getTime() + HOUR_MS), () => runTick(tickConfig()));
    state = await pollState(ctx.project.id, target.id);
    expect(state?.frozenAt).toBeNull();
    expect(state?.nextPollAt?.getTime()).toBe(NOW.getTime() + 2 * HOUR_MS);
  });
});
