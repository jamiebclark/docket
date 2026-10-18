import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "../../../src/server/db/client";
import { accountMetricPollStates } from "../../../src/server/db/schema";
import { buildAccountTrends } from "../../../src/server/services/insights/view";
import { closeDb } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";

afterAll(closeDb);

const DAY_MS = 86_400_000;
const TIME_ZONE = "UTC";

async function connect(scope: Awaited<ReturnType<typeof postsEnv>>["scope"], providerKey: string, displayName: string) {
  return scope.accounts.upsertConnected({
    providerKey,
    displayName,
    externalAccountId: `${providerKey}-${Math.random().toString(36).slice(2, 8)}`,
    settings: {},
    credentialsEncrypted: null,
    credentialsExpiresAt: null,
    connectedByUserId: null,
  });
}

describe("insights account trends (quickstart.md §2, US1, FR-010 to FR-016)", () => {
  it("one chart per account with the platform's own metric label, never a combined total (FR-010, FR-011, FR-012, US1.4)", async () => {
    const env = await postsEnv();
    const insta1 = await connect(env.scope, "instagram", "Instagram one");
    const insta2 = await connect(env.scope, "instagram", "Instagram two");
    const now = new Date();
    await env.scope.accountMetricSnapshots.insertIfAbsent({ socialAccountId: insta1.id, providerKey: "instagram", capturedAt: now, metrics: { reach: 10 } });
    await env.scope.accountMetricSnapshots.insertIfAbsent({ socialAccountId: insta2.id, providerKey: "instagram", capturedAt: now, metrics: { reach: 20 } });

    const { series } = await buildAccountTrends({
      projectId: env.project.id,
      timeZone: TIME_ZONE,
      accounts: [insta1, insta2].map((a) => ({ id: a.id, displayName: a.displayName, providerKey: a.providerKey })),
      range: { from: new Date(now.getTime() - DAY_MS), to: new Date(now.getTime() + DAY_MS) },
      accountMetricPollStates: env.scope.accountMetricPollStates,
    });

    const reach = series.filter((s) => s.metricKey === "reach");
    expect(reach).toHaveLength(2); // two accounts, two series
    expect(reach.every((s) => s.label === "Reach")).toBe(true);
    expect(new Set(reach.map((s) => s.accountId)).size).toBe(2);
    expect(reach.map((s) => s.points[0]!.value).sort()).toEqual([10, 20]); // never summed
  });

  it("a Bluesky followersCount line rises and falls (US1.1)", async () => {
    const env = await postsEnv();
    const bluesky = await connect(env.scope, "bluesky", "Bluesky account");
    const now = Date.now();
    const readings = [100, 90, 110, 105];
    for (let i = 0; i < readings.length; i++) {
      await env.scope.accountMetricSnapshots.insertIfAbsent({
        socialAccountId: bluesky.id,
        providerKey: "bluesky",
        capturedAt: new Date(now - (readings.length - i) * DAY_MS),
        metrics: { followersCount: readings[i] },
      });
    }

    const { series } = await buildAccountTrends({
      projectId: env.project.id,
      timeZone: TIME_ZONE,
      accounts: [{ id: bluesky.id, displayName: bluesky.displayName, providerKey: bluesky.providerKey }],
      range: { from: new Date(now - 10 * DAY_MS), to: new Date(now + DAY_MS) },
      accountMetricPollStates: env.scope.accountMetricPollStates,
    });

    const followers = series.find((s) => s.metricKey === "followersCount");
    expect(followers?.points.map((p) => p.value)).toEqual(readings);
  });

  it("an Instagram reach read four times a day shows at most one value per project-local day (US1.2, FR-013)", async () => {
    const env = await postsEnv();
    const instagram = await connect(env.scope, "instagram", "Instagram account");
    const day = new Date("2026-09-10T00:00:00Z");
    for (const hour of [1, 7, 13, 19]) {
      await env.scope.accountMetricSnapshots.insertIfAbsent({
        socialAccountId: instagram.id,
        providerKey: "instagram",
        capturedAt: new Date(day.getTime() + hour * 3_600_000),
        metrics: { reach: hour },
      });
    }

    const { series } = await buildAccountTrends({
      projectId: env.project.id,
      timeZone: TIME_ZONE,
      accounts: [{ id: instagram.id, displayName: instagram.displayName, providerKey: instagram.providerKey }],
      range: { from: day, to: new Date(day.getTime() + DAY_MS) },
      accountMetricPollStates: env.scope.accountMetricPollStates,
    });

    const reach = series.find((s) => s.metricKey === "reach");
    expect(reach?.points).toHaveLength(1);
    expect(reach?.points[0]!.value).toBe(19); // the newest reading that day wins, never a sum
  });

  it("Threads produces no chart and no zero series, with a note naming the platform (US1.3, FR-015)", async () => {
    const env = await postsEnv();
    const threads = await connect(env.scope, "threads", "Threads account");
    const now = new Date();

    const { series, trendNotes } = await buildAccountTrends({
      projectId: env.project.id,
      timeZone: TIME_ZONE,
      accounts: [{ id: threads.id, displayName: threads.displayName, providerKey: threads.providerKey }],
      range: { from: new Date(now.getTime() - DAY_MS), to: new Date(now.getTime() + DAY_MS) },
      accountMetricPollStates: env.scope.accountMetricPollStates,
    });

    expect(series).toHaveLength(0);
    expect(trendNotes).toEqual([{ kind: "platform_no_account_metrics", providerKey: "threads", platform: "Threads" }]);
  });

  it("a week of failed polling is a visible gap, and the series carries the last successful read (US1.5, FR-014)", async () => {
    const env = await postsEnv();
    const bluesky = await connect(env.scope, "bluesky", "Bluesky account");
    const now = Date.now();
    const lastGood = new Date(now - 8 * DAY_MS);
    await env.scope.accountMetricSnapshots.insertIfAbsent({ socialAccountId: bluesky.id, providerKey: "bluesky", capturedAt: lastGood, metrics: { followersCount: 50 } });
    await getDb()
      .insert(accountMetricPollStates)
      .values({ socialAccountId: bluesky.id, projectId: env.project.id, lastCapturedAt: lastGood })
      .onConflictDoNothing();

    const { series } = await buildAccountTrends({
      projectId: env.project.id,
      timeZone: TIME_ZONE,
      accounts: [{ id: bluesky.id, displayName: bluesky.displayName, providerKey: bluesky.providerKey }],
      range: { from: new Date(now - 10 * DAY_MS), to: new Date(now + DAY_MS) },
      accountMetricPollStates: env.scope.accountMetricPollStates,
    });

    const followers = series.find((s) => s.metricKey === "followersCount");
    expect(followers?.points.map((p) => p.day)).toEqual([lastGood.toISOString().slice(0, 10)]); // the week since is a gap, not zero or interpolated
    expect(followers?.lastSuccessfulReadAt?.toISOString()).toBe(lastGood.toISOString());
  });

  it("page_follows is absent from the trend with its reason shown (US1.6, FR-004)", async () => {
    const env = await postsEnv();
    const facebook = await connect(env.scope, "facebook", "Facebook Page");
    const now = new Date();
    await env.scope.accountMetricSnapshots.insertIfAbsent({ socialAccountId: facebook.id, providerKey: "facebook", capturedAt: now, metrics: { page_follows: 500 } });

    const { series, trendNotes } = await buildAccountTrends({
      projectId: env.project.id,
      timeZone: TIME_ZONE,
      accounts: [{ id: facebook.id, displayName: facebook.displayName, providerKey: facebook.providerKey }],
      range: { from: new Date(now.getTime() - DAY_MS), to: new Date(now.getTime() + DAY_MS) },
      accountMetricPollStates: env.scope.accountMetricPollStates,
    });

    expect(series.some((s) => s.metricKey === "page_follows")).toBe(false);
    const note = trendNotes.find((n) => n.kind === "unknown_metric_shape" && n.metricKey === "page_follows");
    expect(note).toBeDefined();
    expect((note as { reason: string }).reason.length).toBeGreaterThan(0);
    // grep the rendered page for a bare "0" beside this metric — there should be none (SC-007):
    // the note carries a reason, never a zero or empty series.
  });
});
