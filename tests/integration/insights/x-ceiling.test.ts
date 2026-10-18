import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../../src/server/db/client";
import { postMetricPollStates, postMetricSnapshots } from "../../../src/server/db/schema";
import { forSchedulerProject } from "../../../src/server/dal/scheduler";
import { encryptCredentials } from "../../../src/server/services/accounts";
import { runTick } from "../../../src/server/scheduler";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { createProjectWithMembers } from "../../helpers/factories";
import { createFakeX, type FakeX } from "../../helpers/fake-x";
import { createDueTarget, parkAllDueTargets } from "../../helpers/scheduling";
import { tickConfig } from "../../helpers/tick";

afterAll(closeDb);

const NOW = new Date("2026-04-01T00:00:00Z");
const ACCESS = "X-ACCESS-TOKEN-ceiling-0123456789";
const REFRESH = "X-REFRESH-TOKEN-ceiling-0123456789";

let fake: FakeX;
beforeEach(async () => {
  await parkAllDueTargets();
  fake = createFakeX().install();
  fake.secrets(ACCESS, REFRESH);
  vi.stubEnv("X_INSIGHTS_ENABLED", "true");
  vi.stubEnv("X_INSIGHTS_READ_CEILING", "100"); // the parser's minimum; realised ceiling is 50
});
afterEach(() => {
  fake.uninstall();
  vi.unstubAllEnvs();
});

async function connectedXAccount(projectId: string) {
  const repos = forSchedulerProject(projectId);
  const account = await repos.accounts.upsertConnected({
    providerKey: "x",
    displayName: "@dockettest",
    externalAccountId: "x-ceiling-1",
    settings: { username: "dockettest", name: "Docket Test" },
    credentialsEncrypted: null,
    credentialsExpiresAt: null,
    connectedByUserId: null,
    grantedScopes: ["tweet.read", "tweet.write", "users.read", "media.write", "offline.access"],
  });
  const credentials = { v: 1, accessToken: ACCESS, refreshToken: REFRESH, accessExpiresAt: NOW.getTime() + 3_600_000, refreshIssuedAt: NOW.getTime() };
  const expires = new Date(NOW.getTime() + 180 * 86_400_000);
  await repos.accounts.setCredentials(account.id, encryptCredentials(account.id, credentials), expires);
  return { repos, account };
}

/** Seeds `n` post-metric snapshot rows for the account's window directly, bypassing the tick, so
 * the realised ceiling (50) is reached without 50 real HTTP round trips. */
async function fillSnapshots(repos: ReturnType<typeof forSchedulerProject>, projectId: string, accountId: string, targetId: string, n: number) {
  for (let i = 0; i < n; i++) {
    await repos.postMetricSnapshots.insertIfAbsent({
      postTargetId: targetId,
      socialAccountId: accountId,
      providerKey: "x",
      capturedAt: new Date(NOW.getTime() - (n - i) * 1000),
      metrics: { like_count: 1 },
    });
  }
}

describe("X's priced read ceiling (contracts/x-metered-reads.md §2-§3, FR-039, FR-040, SC-005, SC-007)", () => {
  it("stops reads once the realised ceiling is reached, counts the deferral, flags no target, and still publishes a scheduled post for the same account", async () => {
    const ctx = await createProjectWithMembers();
    const { repos, account } = await connectedXAccount(ctx.project.id);

    const publishedAt = new Date(NOW.getTime() - 2 * 3_600_000); // outside the 1-hour-after-publish floor, so the poll is already due
    const post = await repos.posts.insert({ baseText: "Hello" });
    const [pollTarget] = await repos.targets.insertMany([{ postId: post.id, socialAccountId: account.id }]);
    await repos.targets.update(pollTarget!.id, { status: "published", externalId: "1001", publishedAt });
    await fillSnapshots(repos, ctx.project.id, account.id, pollTarget!.id, 50); // at the realised ceiling

    fake.on("POST", "/2/tweets", { kind: "ok", status: 201, body: { data: { id: "2002", text: "scheduled" } } });
    const { target: scheduledTarget } = await createDueTarget(ctx.project.id, account.id, { dueAt: new Date(NOW.getTime() - 1_000) });

    const summary = await atTime(NOW, () => runTick(tickConfig()));
    expect(summary.insightsPoll.counts.deferredForAllowance).toBeGreaterThanOrEqual(1);
    expect(fake.callsTo("GET", "/2/tweets")).toHaveLength(0);
    expect(summary.publishing.ok).toBe(true);

    const published = await repos.targets.get(scheduledTarget.id);
    expect(published?.status).toBe("published");
    expect(published?.externalId).not.toBeNull();

    const [pollState] = await getDb()
      .select()
      .from(postMetricPollStates)
      .where(and(eq(postMetricPollStates.projectId, ctx.project.id), eq(postMetricPollStates.postTargetId, pollTarget!.id)));
    expect(pollState?.consecutiveFailures).toBe(0);
    expect(pollState?.lastError).toBeNull();
    expect(pollState?.pollLeaseUntil).toBeNull();
  });

  it("flipping the opt-in back off after snapshots exist leaves them in place, makes no further call, and errors nothing", async () => {
    const ctx = await createProjectWithMembers();
    const { repos, account } = await connectedXAccount(ctx.project.id);
    const publishedAt = new Date(NOW.getTime() - 2 * 3_600_000);
    const post = await repos.posts.insert({ baseText: "Hello" });
    const [target] = await repos.targets.insertMany([{ postId: post.id, socialAccountId: account.id }]);
    await repos.targets.update(target!.id, { status: "published", externalId: "1001", publishedAt });

    fake.on("GET", "/2/tweets", { kind: "ok", body: { data: [{ id: "1001", public_metrics: { like_count: 5 } }] } });
    const first = await atTime(NOW, () => runTick(tickConfig()));
    expect(first.insightsPoll.counts.deferredForAllowance).toBe(0);
    const [before] = await getDb()
      .select()
      .from(postMetricSnapshots)
      .where(and(eq(postMetricSnapshots.projectId, ctx.project.id), eq(postMetricSnapshots.postTargetId, target!.id)));
    expect(before).toBeDefined();

    vi.stubEnv("X_INSIGHTS_ENABLED", "false");
    fake.reset();
    fake.secrets(ACCESS, REFRESH);
    const later = new Date(NOW.getTime() + 3_600_000);
    await expect(atTime(later, () => runTick(tickConfig()))).resolves.toBeDefined();
    expect(fake.requests).toHaveLength(0);

    const [after] = await getDb()
      .select()
      .from(postMetricSnapshots)
      .where(and(eq(postMetricSnapshots.projectId, ctx.project.id), eq(postMetricSnapshots.postTargetId, target!.id)));
    expect(after).toEqual(before);
  });
});
