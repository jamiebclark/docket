import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { setLlmForTests } from "../../../src/server/llm";
import { runStandingSeries, type StandingSeriesCounts } from "../../../src/server/scheduler/standing-series";
import type { SchedulerConfig } from "../../../src/server/scheduler/config";
import { createStandingSeries } from "../../../src/server/services/standing-series/manage";
import { getDb } from "../../../src/server/db/client";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { socialAccounts, standingSeries } from "../../../src/server/db/schema";
import * as accounts from "../../../src/server/services/accounts";
import { closeDb } from "../../helpers/db";
import { atTime } from "../../helpers/clock";
import { createFakeLlm, type FakeStep } from "../../helpers/fake-llm";
import { clearHolds } from "../../helpers/jobs-env";
import { standingSeriesEnv } from "../../helpers/standing-series-env";

const CONFIG: SchedulerConfig = {
  timeBudgetMs: 120_000,
  maxItems: 10,
  leaseMs: 300_000,
  providerTimeoutMs: 20_000,
  maxAttempts: 3,
  backoffBaseMs: 60_000,
  backoffMaxMs: 900_000,
  maxPublishDurationMs: 3_600_000,
  refreshWindowMs: 7_200_000,
  refreshMaxAccounts: 5,
  batchSize: 4,
  standingSeriesMaxSeries: 5,
  standingSeriesMaxPosts: 5,
};

async function parkOtherSeries(): Promise<void> {
  await runCrossProject("test: park standing series", async () => {
    await getDb().update(standingSeries).set({ enabled: false }).where(eq(standingSeries.enabled, true));
  });
}

beforeEach(async () => {
  await clearHolds();
  await parkOtherSeries();
});
afterEach(async () => {
  setLlmForTests(null);
  await clearHolds();
});
afterAll(async () => {
  await closeDb();
});

const post = (text: string): FakeStep => ({ ok: { variants: { mock: { text } } } });

async function tick(at: Date): Promise<StandingSeriesCounts> {
  return atTime(at, () => runStandingSeries({ config: CONFIG, tickId: "test", startedAt: at }));
}

const POLICIES = [
  { approval: "review_required" as const, scheduling: "leave_as_draft" as const },
  { approval: "auto_approve" as const, scheduling: "add_to_queue" as const },
  { approval: "auto_approve" as const, scheduling: "leave_as_draft" as const },
] as const;

describe("standing-series policy application (US2 AS1-AS4, FR-029, FR-030, FR-033, SC-005)", () => {
  for (const { approval, scheduling } of POLICIES) {
    it(`${approval} + ${scheduling}: a valid post gets the exact review/queue outcome`, async () => {
      const e = await standingSeriesEnv();
      const created = new Date("2026-01-10T00:00:00.000Z");
      await atTime(created, () =>
        createStandingSeries(
          e.scope,
          e.create({ cadence: { count: 1, period: "day" }, approval, scheduling, confirmUnreviewedQueue: true }),
        ),
      );
      setLlmForTests(createFakeLlm([post("A fine post.")]));
      const counts = await tick(new Date("2026-01-11T00:00:01.000Z"));
      expect(counts.produced).toBe(1);

      const { rows } = await e.scope.standingSeries.list({ page: 1, pageSize: 10 });
      const runs = await e.scope.standingSeriesRuns.listForSeries(rows[0]!.id, { limit: 5 });
      const positions = await e.scope.standingSeriesPositions.listForRun(runs[0]!.id);
      const post1 = await e.scope.posts.findByStandingSeriesPosition(positions[0]!.id);
      expect(post1).not.toBeNull();
      expect(post1!.reviewState).toBe(approval === "auto_approve" ? "approved" : "needs_review");

      const targets = await e.scope.targets.listForPost(post1!.id);
      const queued = approval === "auto_approve" && scheduling === "add_to_queue";
      expect(targets.every((t) => (queued ? t.status === "scheduled" : t.status === "draft"))).toBe(true);
    });
  }

  it("auto_approve + add_to_queue: a content-validation failure (text-only Instagram) forces review regardless of policy", async () => {
    const e = await standingSeriesEnv();
    const ig = await accounts.saveConnectedAccount(e.scope, {
      providerKey: "instagram",
      externalAccountId: `ig-${randomUUID().slice(0, 8)}`,
      displayName: "Insta",
      settings: {},
    });
    const created = new Date("2026-01-10T00:00:00.000Z");
    await atTime(created, () =>
      createStandingSeries(
        e.scope,
        e.create({
          cadence: { count: 1, period: "day" },
          targetAccountIds: [ig.id],
          approval: "auto_approve",
          scheduling: "add_to_queue",
          confirmUnreviewedQueue: true,
        }),
      ),
    );
    setLlmForTests(
      createFakeLlm([
        { ok: { variants: { instagram: { text: "Fine." } } } },
        { ok: { variants: { instagram: { text: "Fine." } } } },
      ]),
    );
    const counts = await tick(new Date("2026-01-11T00:00:01.000Z"));
    expect(counts.produced).toBe(1);

    const { rows } = await e.scope.standingSeries.list({ page: 1, pageSize: 10 });
    const runs = await e.scope.standingSeriesRuns.listForSeries(rows[0]!.id, { limit: 5 });
    const positions = await e.scope.standingSeriesPositions.listForRun(runs[0]!.id);
    const saved = await e.scope.posts.findByStandingSeriesPosition(positions[0]!.id);
    expect(saved!.reviewState).toBe("needs_review");
    const targets = await e.scope.targets.listForPost(saved!.id);
    expect(targets.some((t) => t.status === "scheduled")).toBe(false);
  });

  it("an unavailable-but-not-invalid account does not force review", async () => {
    const e = await standingSeriesEnv();
    const needsReauth = await e.addAccount();
    await runCrossProject("test: mark account needs_reauth", () =>
      getDb()
        .update(socialAccounts)
        .set({ status: "needs_reauth" })
        .where(and(eq(socialAccounts.id, needsReauth.id), eq(socialAccounts.projectId, e.project.id))),
    );
    const created = new Date("2026-01-10T00:00:00.000Z");
    await atTime(created, () =>
      createStandingSeries(
        e.scope,
        e.create({
          cadence: { count: 1, period: "day" },
          targetAccountIds: [e.account.id, needsReauth.id],
          approval: "auto_approve",
          scheduling: "leave_as_draft",
        }),
      ),
    );
    setLlmForTests(createFakeLlm([post("A fine post.")]));
    const counts = await tick(new Date("2026-01-11T00:00:01.000Z"));
    expect(counts.produced).toBe(1);
    const { rows } = await e.scope.standingSeries.list({ page: 1, pageSize: 10 });
    const runs = await e.scope.standingSeriesRuns.listForSeries(rows[0]!.id, { limit: 5 });
    const positions = await e.scope.standingSeriesPositions.listForRun(runs[0]!.id);
    const saved = await e.scope.posts.findByStandingSeriesPosition(positions[0]!.id);
    expect(saved!.reviewState).toBe("approved");
  });

  it("applyApprovalPolicy is called from exactly one place in standing-series, and decidePolicy has no standing-series branch", () => {
    const runnerSrc = readFileSync("src/server/services/standing-series/runner.ts", "utf8");
    const calls = runnerSrc.match(/applyApprovalPolicy\(/g) ?? [];
    expect(calls).toHaveLength(1);

    const policySrc = readFileSync("src/server/services/generation/policy.ts", "utf8");
    expect(policySrc).not.toMatch(/standing/i);
  });
}, 60_000);
