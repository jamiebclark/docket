import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { setLlmForTests } from "../../../src/server/llm";
import { runStandingSeries, type StandingSeriesCounts } from "../../../src/server/scheduler/standing-series";
import type { SchedulerConfig } from "../../../src/server/scheduler/config";
import { createStandingSeries } from "../../../src/server/services/standing-series/manage";
import * as posts from "../../../src/server/services/posts";
import * as slots from "../../../src/server/services/slots";
import { getDb } from "../../../src/server/db/client";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { standingSeries } from "../../../src/server/db/schema";
import { getEnv } from "../../../src/server/env";
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

function tick(at: Date): Promise<StandingSeriesCounts> {
  return atTime(at, () => runStandingSeries({ config: CONFIG, tickId: "test", startedAt: at }));
}

describe("standing-series slot exclusivity (US3 AS4, FR-031, FR-032, SC-004)", () => {
  it("two enabled series sharing an account never collide on an occurrence under concurrent ticks", async () => {
    const e = await standingSeriesEnv();
    // A small grid: the default Monday slot plus two more, enough for both series' single posts.
    await slots.addSlot(e.scope, { accountId: e.account.id, weekday: 3, localTime: "09:00" });
    await slots.addSlot(e.scope, { accountId: e.account.id, weekday: 5, localTime: "09:00" });

    const created = new Date("2026-01-10T00:00:00.000Z");
    const policy = { approval: "auto_approve" as const, scheduling: "add_to_queue" as const, confirmUnreviewedQueue: true };
    const { seriesId: seriesA } = await atTime(created, () =>
      createStandingSeries(e.scope, e.create({ ...policy, cadence: { count: 1, period: "day" } })),
    );
    const { seriesId: seriesB } = await atTime(created, () =>
      createStandingSeries(e.scope, e.create({ ...policy, cadence: { count: 1, period: "day" } })),
    );

    setLlmForTests(createFakeLlm([post("Post from A."), post("Post from B.")]));
    const firing = new Date("2026-01-11T00:00:01.000Z");
    const [a, b] = await Promise.all([tick(firing), tick(firing)]);
    expect(a.produced + b.produced).toBe(2);

    const runsA = await e.scope.standingSeriesRuns.listForSeries(seriesA, { limit: 5 });
    const runsB = await e.scope.standingSeriesRuns.listForSeries(seriesB, { limit: 5 });
    expect(runsA).toHaveLength(1);
    expect(runsB).toHaveLength(1);
    const positionsA = await e.scope.standingSeriesPositions.listForRun(runsA[0]!.id);
    const positionsB = await e.scope.standingSeriesPositions.listForRun(runsB[0]!.id);
    expect(positionsA).toHaveLength(1);
    expect(positionsB).toHaveLength(1);

    const postA = await e.scope.posts.findByStandingSeriesPosition(positionsA[0]!.id);
    const postB = await e.scope.posts.findByStandingSeriesPosition(positionsB[0]!.id);
    expect(postA).not.toBeNull();
    expect(postB).not.toBeNull();
    const targetsA = await e.scope.targets.listForPost(postA!.id);
    const targetsB = await e.scope.targets.listForPost(postB!.id);
    expect(targetsA.every((t) => t.status === "scheduled")).toBe(true);
    expect(targetsB.every((t) => t.status === "scheduled")).toBe(true);

    // Every queued target holds a distinct occurrence: the unique index was never violated (no throw above),
    // and the two posts' scheduled instants differ even though they share an account and slot grid.
    const scheduledAtA = targetsA[0]!.scheduledAt!.getTime();
    const scheduledAtB = targetsB[0]!.scheduledAt!.getTime();
    expect(scheduledAtA).not.toBe(scheduledAtB);
  }, 60_000);

  it("a target whose account has exhausted the queue horizon stays a draft with the allocator's own reason, and is not retried under another policy", async () => {
    const e = await standingSeriesEnv();
    const account = await e.addAccount();
    const created = new Date("2026-01-10T00:00:00.000Z");
    const { seriesId } = await atTime(created, () =>
      createStandingSeries(
        e.scope,
        e.create({
          targetAccountIds: [account.id],
          approval: "auto_approve",
          scheduling: "add_to_queue",
          confirmUnreviewedQueue: true,
          cadence: { count: 1, period: "day" },
        }),
      ),
    );

    const firing = new Date("2026-01-11T00:00:01.000Z");
    // Exhaust the one weekly slot across the whole queue horizon with unrelated drafts, directly, so the
    // series' own target has nowhere left to land when it tries to queue.
    const weeks = Math.ceil(getEnv().QUEUE_HORIZON_DAYS / 7) + 2;
    let exhausted = false;
    await atTime(firing, async () => {
      for (let i = 0; i < weeks; i++) {
        const filler = await posts.createDraft(e.scope, { baseText: "filler", targets: [{ accountId: account.id }] });
        const [result] = await posts.addToQueue(e.scope, filler.post.id);
        if (result!.ok === false) {
          expect(result).toMatchObject({ code: "no_free_occurrence" });
          exhausted = true;
          break;
        }
      }
    });
    expect(exhausted).toBe(true);

    setLlmForTests(createFakeLlm([post("A fine post.")]));
    const counts = await tick(firing);
    expect(counts.produced).toBe(1);

    const runs = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 5 });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.closedAt).not.toBeNull();
    const positions = await e.scope.standingSeriesPositions.listForRun(runs[0]!.id);
    expect(positions).toHaveLength(1);

    const saved = await e.scope.posts.findByStandingSeriesPosition(positions[0]!.id);
    expect(saved).not.toBeNull();
    // The policy still approved it (no content-validation failure); only the queue step had nowhere to put it.
    expect(saved!.reviewState).toBe("approved");
    const targets = await e.scope.targets.listForPost(saved!.id);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.status).toBe("draft");
    expect(targets[0]!.scheduledAt).toBeNull();

    // The allocator's own reason, not a generic refusal: asking it to queue again gives the same code and
    // message an unrelated post would get from an exhausted account, with no standing-series-specific retry.
    const [retry] = await atTime(firing, () => posts.addToQueue(e.scope, saved!.id));
    expect(retry).toMatchObject({ ok: false, code: "no_free_occurrence" });
    expect((retry as { message: string }).message).toMatch(/no free posting slot in the next \d+ days/);
  }, 120_000);
}, 120_000);
