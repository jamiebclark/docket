import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { setLlmForTests } from "../../../src/server/llm";
import { runStandingSeries, type StandingSeriesCounts } from "../../../src/server/scheduler/standing-series";
import type { SchedulerConfig } from "../../../src/server/scheduler/config";
import { createStandingSeries } from "../../../src/server/services/standing-series/manage";
import * as posts from "../../../src/server/services/posts";
import * as slots from "../../../src/server/services/slots";
import * as accounts from "../../../src/server/services/accounts";
import { getDb } from "../../../src/server/db/client";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { standingSeries } from "../../../src/server/db/schema";
import { getEnv } from "../../../src/server/env";
import type { NewDatedRow } from "../../../src/server/dal/standing-series-dated";
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

/** Project timezone is UTC (factories default), so a row's local date matches its UTC date. */
function rowInput(over: Partial<NewDatedRow> & { ordinal: number }): NewDatedRow {
  return {
    month: 3,
    day: 14,
    year: null,
    keyValue: "Ada Lovelace",
    fields: { name: "Ada Lovelace" },
    mediaFilename: null,
    mediaAssetId: null,
    nextTargetDate: null,
    sourceLine: over.ordinal + 2,
    ...over,
  };
}

describe("dated series lead time (US4 AS1-AS5, FR-030, SC-003, B13)", () => {
  it("AS1: a lead time of 3 produces the post three days early and nothing on the two days after", async () => {
    const e = await standingSeriesEnv();
    const created = new Date("2026-01-01T00:00:00.000Z");
    const { seriesId } = await atTime(created, () =>
      createStandingSeries(e.scope, e.create({ occurrenceRule: "dated_list", cadence: null, leadDays: 3 })),
    );
    await e.scope.datedRows.insert(seriesId, rowInput({ ordinal: 0, nextTargetDate: "2026-03-14" }));

    setLlmForTests(createFakeLlm([post("Too early.")]));
    expect((await tick(new Date("2026-03-10T00:00:01.000Z"))).produced).toBe(0);

    setLlmForTests(createFakeLlm([post("Three days early.")]));
    expect((await tick(new Date("2026-03-11T00:00:01.000Z"))).produced).toBe(1);

    setLlmForTests(createFakeLlm([post("Should not run again.")]));
    expect((await tick(new Date("2026-03-12T00:00:01.000Z"))).produced).toBe(0);
    expect((await tick(new Date("2026-03-13T00:00:01.000Z"))).produced).toBe(0);

    const runs = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 5 });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.periodStart).toBe("2026-03-14");
  });

  it("AS2: auto-approve + queue holds a slot at or after local midnight of the target date, never earlier", async () => {
    const e = await standingSeriesEnv();
    // A slot every day, so without the queue floor the allocator would land on the firing day itself.
    await slots.addSlotsForWeek(e.scope, { accountId: e.account.id, localTime: "09:00" });
    const created = new Date("2026-01-01T00:00:00.000Z");
    const { seriesId } = await atTime(created, () =>
      createStandingSeries(
        e.scope,
        e.create({
          occurrenceRule: "dated_list",
          cadence: null,
          leadDays: 3,
          approval: "auto_approve",
          scheduling: "add_to_queue",
          confirmUnreviewedQueue: true,
        }),
      ),
    );
    await e.scope.datedRows.insert(seriesId, rowInput({ ordinal: 0, nextTargetDate: "2026-03-14" }));

    setLlmForTests(createFakeLlm([post("Three days early.")]));
    expect((await tick(new Date("2026-03-11T00:00:01.000Z"))).produced).toBe(1);

    const runs = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 5 });
    const positions = await e.scope.standingSeriesPositions.listForRun(runs[0]!.id);
    const saved = await e.scope.posts.findByStandingSeriesPosition(positions[0]!.id);
    expect(saved).not.toBeNull();
    expect(saved!.reviewState).toBe("approved");
    const targets = await e.scope.targets.listForPost(saved!.id);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.status).toBe("scheduled");
    // Local midnight of the target date (UTC project timezone).
    expect(targets[0]!.scheduledAt!.getTime()).toBeGreaterThanOrEqual(new Date("2026-03-14T00:00:00.000Z").getTime());
  });

  it("the queueFloor guarantee still holds when a reviewer approves from Review afterward", async () => {
    const e = await standingSeriesEnv();
    await slots.addSlotsForWeek(e.scope, { accountId: e.account.id, localTime: "09:00" });
    const created = new Date("2026-01-01T00:00:00.000Z");
    const { seriesId } = await atTime(created, () =>
      createStandingSeries(
        e.scope,
        e.create({ occurrenceRule: "dated_list", cadence: null, leadDays: 3, approval: "review_required" }),
      ),
    );
    await e.scope.datedRows.insert(seriesId, rowInput({ ordinal: 0, nextTargetDate: "2026-03-14" }));

    setLlmForTests(createFakeLlm([post("Three days early.")]));
    const firing = new Date("2026-03-11T00:00:01.000Z");
    expect((await tick(firing)).produced).toBe(1);

    const runs = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 5 });
    const positions = await e.scope.standingSeriesPositions.listForRun(runs[0]!.id);
    const saved = await e.scope.posts.findByStandingSeriesPosition(positions[0]!.id);
    expect(saved!.reviewState).toBe("needs_review");

    await posts.setReviewState(e.scope, saved!.id, "approved");
    await atTime(firing, () => posts.addToQueue(e.scope, saved!.id));

    const targets = await e.scope.targets.listForPost(saved!.id);
    expect(targets[0]!.status).toBe("scheduled");
    expect(targets[0]!.scheduledAt!.getTime()).toBeGreaterThanOrEqual(new Date("2026-03-14T00:00:00.000Z").getTime());
  });

  it("AS3: review-required leaves the post in Review with no slot held", async () => {
    const e = await standingSeriesEnv();
    await slots.addSlotsForWeek(e.scope, { accountId: e.account.id, localTime: "09:00" });
    const created = new Date("2026-01-01T00:00:00.000Z");
    const { seriesId } = await atTime(created, () =>
      createStandingSeries(
        e.scope,
        e.create({ occurrenceRule: "dated_list", cadence: null, leadDays: 3, approval: "review_required", scheduling: "add_to_queue" }),
      ),
    );
    await e.scope.datedRows.insert(seriesId, rowInput({ ordinal: 0, nextTargetDate: "2026-03-14" }));

    setLlmForTests(createFakeLlm([post("Three days early.")]));
    expect((await tick(new Date("2026-03-11T00:00:01.000Z"))).produced).toBe(1);

    const runs = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 5 });
    const positions = await e.scope.standingSeriesPositions.listForRun(runs[0]!.id);
    const saved = await e.scope.posts.findByStandingSeriesPosition(positions[0]!.id);
    expect(saved!.reviewState).toBe("needs_review");
    const targets = await e.scope.targets.listForPost(saved!.id);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.status).toBe("draft");
    expect(targets[0]!.scheduledAt).toBeNull();
  });

  it("AS4: the queue-horizon-exhausted case stays an approved draft, not queued earlier than the target date", async () => {
    const e = await standingSeriesEnv();
    const account = await e.addAccount();
    const created = new Date("2026-01-01T00:00:00.000Z");
    const { seriesId } = await atTime(created, () =>
      createStandingSeries(
        e.scope,
        e.create({
          occurrenceRule: "dated_list",
          cadence: null,
          leadDays: 3,
          targetAccountIds: [account.id],
          approval: "auto_approve",
          scheduling: "add_to_queue",
          confirmUnreviewedQueue: true,
        }),
      ),
    );
    await e.scope.datedRows.insert(seriesId, rowInput({ ordinal: 0, nextTargetDate: "2026-03-14" }));

    const firing = new Date("2026-03-11T00:00:01.000Z");
    // Exhaust the one weekly slot across the whole queue horizon (and then some), from the firing
    // day forward, so there is nothing free anywhere at or after the target date's midnight either.
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

    setLlmForTests(createFakeLlm([post("Three days early.")]));
    expect((await tick(firing)).produced).toBe(1);

    const runs = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 5 });
    const positions = await e.scope.standingSeriesPositions.listForRun(runs[0]!.id);
    const saved = await e.scope.posts.findByStandingSeriesPosition(positions[0]!.id);
    expect(saved).not.toBeNull();
    expect(saved!.reviewState).toBe("approved");
    const targets = await e.scope.targets.listForPost(saved!.id);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.status).toBe("draft");
    expect(targets[0]!.scheduledAt).toBeNull();
  }, 120_000);

  it("AS5: a content-validation failure leaves it in review under auto-approve", async () => {
    const e = await standingSeriesEnv();
    const ig = await accounts.saveConnectedAccount(e.scope, {
      providerKey: "instagram",
      externalAccountId: `ig-${randomUUID().slice(0, 8)}`,
      displayName: "Insta",
      settings: {},
    });
    const created = new Date("2026-01-01T00:00:00.000Z");
    const { seriesId } = await atTime(created, () =>
      createStandingSeries(
        e.scope,
        e.create({
          occurrenceRule: "dated_list",
          cadence: null,
          leadDays: 3,
          targetAccountIds: [ig.id],
          approval: "auto_approve",
          scheduling: "add_to_queue",
          confirmUnreviewedQueue: true,
        }),
      ),
    );
    await e.scope.datedRows.insert(seriesId, rowInput({ ordinal: 0, nextTargetDate: "2026-03-14" }));

    setLlmForTests(
      createFakeLlm([
        { ok: { variants: { instagram: { text: "Fine." } } } },
        { ok: { variants: { instagram: { text: "Fine." } } } },
      ]),
    );
    expect((await tick(new Date("2026-03-11T00:00:01.000Z"))).produced).toBe(1);

    const runs = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 5 });
    const positions = await e.scope.standingSeriesPositions.listForRun(runs[0]!.id);
    const saved = await e.scope.posts.findByStandingSeriesPosition(positions[0]!.id);
    expect(saved!.reviewState).toBe("needs_review");
    const targets = await e.scope.targets.listForPost(saved!.id);
    expect(targets.some((t) => t.status === "scheduled")).toBe(false);
  });
});
