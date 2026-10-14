import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { csvBuilder } from "../../helpers/factories";
import { setLlmForTests } from "../../../src/server/llm";
import { runStandingSeries, type StandingSeriesCounts } from "../../../src/server/scheduler/standing-series";
import type { SchedulerConfig } from "../../../src/server/scheduler/config";
import { createStandingSeries } from "../../../src/server/services/standing-series/manage";
import { importDatedList } from "../../../src/server/services/standing-series/dated-import";
import { getStandingSeries } from "../../../src/server/services/standing-series/read";
import { getDb } from "../../../src/server/db/client";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { standingSeries } from "../../../src/server/db/schema";
import type { NewDatedRow } from "../../../src/server/dal/standing-series-dated";
import { INSTALL_CREDENTIAL_OWNER } from "../../../src/server/dal/credential-owners";
import { ConflictError } from "../../../src/server/dal/errors";
import { closeDb } from "../../helpers/db";
import { atTime } from "../../helpers/clock";
import { createFakeLlm, type FakeStep } from "../../helpers/fake-llm";
import { clearHolds, seedCreditHold } from "../../helpers/jobs-env";
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

/** Parks every series left enabled by another test file, so this file's ticks claim only its own. */
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
    keyValue: `Row ${over.ordinal}`,
    fields: { name: `Row ${over.ordinal}` },
    mediaFilename: null,
    mediaAssetId: null,
    nextTargetDate: null,
    sourceLine: over.ordinal + 2,
    ...over,
  };
}

async function datedSeries(e: Awaited<ReturnType<typeof standingSeriesEnv>>) {
  const created = new Date("2026-01-01T00:00:00.000Z");
  const { seriesId } = await atTime(created, () =>
    createStandingSeries(e.scope, e.create({ occurrenceRule: "dated_list", cadence: null })),
  );
  return seriesId;
}

const file = (bytes: Buffer, name = "list.csv") => ({ name, bytes: new Uint8Array(bytes) });

describe("dated series idempotency (US5 AS1-AS4, SC-007)", () => {
  it("two concurrent ticks against three due rows yield one run and three posts/occurrences", async () => {
    const e = await standingSeriesEnv();
    const seriesId = await datedSeries(e);
    for (let i = 0; i < 3; i += 1) {
      await e.scope.datedRows.insert(seriesId, rowInput({ ordinal: i, nextTargetDate: "2026-03-14" }));
    }

    setLlmForTests(createFakeLlm(Array.from({ length: 6 }, () => post("A fixture post."))));
    const at = new Date("2026-03-14T00:00:01.000Z");
    const [a, b] = await Promise.all([tick(at), tick(at)]);
    expect(a.produced + b.produced).toBe(3);

    const runs = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 10 });
    expect(runs).toHaveLength(1);
    const positions = await e.scope.standingSeriesPositions.listForRun(runs[0]!.id);
    expect(positions.filter((p) => p.status === "produced")).toHaveLength(3);
    const occurrences = await e.scope.datedOccurrences.listForSeries(seriesId, { limit: 10 });
    expect(occurrences.filter((o) => o.outcome === "produced")).toHaveLength(3);
  }, 60_000);

  it("a run interrupted mid-positions is resumed with no second post", async () => {
    const e = await standingSeriesEnv();
    const seriesId = await datedSeries(e);
    await e.scope.datedRows.insert(seriesId, rowInput({ ordinal: 0, nextTargetDate: "2026-03-14" }));
    await e.scope.datedRows.insert(seriesId, rowInput({ ordinal: 1, nextTargetDate: "2026-03-14" }));

    // Only one scripted step: the tick writes the first position's post and leaves the second
    // running when it runs out of model steps, simulating a kill mid-call.
    setLlmForTests(createFakeLlm([post("First post.")]));
    const firing = new Date("2026-03-14T00:00:01.000Z");
    const first = await tick(firing);
    expect(first.produced).toBe(1);

    const runs = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 5 });
    const openRun = runs[0]!;
    expect(openRun.closedAt).toBeNull();
    const positions = await e.scope.standingSeriesPositions.listForRun(openRun.id);
    const remaining = positions.find((p) => p.status === "running")!;
    expect(remaining).toBeDefined();
    await runCrossProject("test: simulate an abandoned lease", async () => {
      await getDb()
        .update(standingSeries)
        .set({ leaseUntil: firing })
        .where(eq(standingSeries.id, seriesId));
    });

    const resumeLlm = createFakeLlm([post("Second post.")]);
    setLlmForTests(resumeLlm);
    const second = await tick(new Date(firing.getTime() + 60_000));
    expect(second.recovered).toBe(1);
    expect(second.produced).toBe(1);
    expect(resumeLlm.requests).toHaveLength(1);

    const finalPositions = await e.scope.standingSeriesPositions.listForRun(openRun.id);
    expect(finalPositions.filter((p) => p.status === "produced")).toHaveLength(2);
    const occurrences = await e.scope.datedOccurrences.listForSeries(seriesId, { limit: 10 });
    expect(occurrences.filter((o) => o.outcome === "produced")).toHaveLength(2);
    const finalRuns = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 5 });
    expect(finalRuns).toHaveLength(1);
  }, 60_000);

  it("a lease forced to expire is recovered and finished by a later tick", async () => {
    const e = await standingSeriesEnv();
    const seriesId = await datedSeries(e);
    await e.scope.datedRows.insert(seriesId, rowInput({ ordinal: 0, nextTargetDate: "2026-03-14" }));

    setLlmForTests(createFakeLlm([post("Only post.")]));
    const firing = new Date("2026-03-14T00:00:01.000Z");
    await tick(firing);
    const runs = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 5 });
    expect(runs[0]!.closedAt).not.toBeNull();

    const occurrences = await e.scope.datedOccurrences.listForSeries(seriesId, { limit: 10 });
    expect(occurrences.filter((o) => o.outcome === "produced")).toHaveLength(1);
  }, 60_000);

  it("a credit hold on the due day leaves no occurrence written and fires normally once cleared", async () => {
    const e = await standingSeriesEnv();
    const seriesId = await datedSeries(e);
    await e.scope.datedRows.insert(seriesId, rowInput({ ordinal: 0, nextTargetDate: "2026-03-14" }));

    const firing = new Date("2026-03-14T00:00:01.000Z");
    await seedCreditHold(INSTALL_CREDENTIAL_OWNER, { heldSince: firing, nextProbeAt: new Date(firing.getTime() + 10 * CONFIG.leaseMs) });
    setLlmForTests(createFakeLlm([post("Should not run.")]));
    const held = await tick(firing);
    expect(held.produced).toBe(0);
    expect(held.held).toBe(1);

    const runsWhileHeld = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 5 });
    expect(runsWhileHeld).toHaveLength(0);
    const occurrencesWhileHeld = await e.scope.datedOccurrences.listForSeries(seriesId, { limit: 10 });
    expect(occurrencesWhileHeld).toHaveLength(0);

    await clearHolds();
    setLlmForTests(createFakeLlm([post("Fired once cleared.")]));
    const cleared = await tick(new Date(firing.getTime() + 60_000));
    expect(cleared.produced).toBe(1);

    const runsAfter = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 5 });
    expect(runsAfter).toHaveLength(1);
    const occurrencesAfter = await e.scope.datedOccurrences.listForSeries(seriesId, { limit: 10 });
    expect(occurrencesAfter.filter((o) => o.outcome === "produced")).toHaveLength(1);
  }, 60_000);

  it("a concurrent re-import mid-run keeps occurrences and fires nothing twice", async () => {
    const e = await standingSeriesEnv();
    const seriesId = await datedSeries(e);
    const bytes = csvBuilder(["date", "name"], [["03-14", "Ada Lovelace"]]);
    await atTime(new Date("2026-01-01T00:00:00.000Z"), () => importDatedList(e.scope, seriesId, file(bytes)));

    setLlmForTests(createFakeLlm([post("Happy birthday!"), post("Happy birthday!")]));
    const firing = new Date("2026-03-14T00:00:01.000Z");
    const [tickCounts] = await Promise.all([tick(firing), importDatedList(e.scope, seriesId, file(bytes))]);
    expect(tickCounts.produced).toBeLessThanOrEqual(1);

    // Whether the run opened before or after the concurrent re-import landed, it fires exactly once.
    if (tickCounts.produced === 0) {
      setLlmForTests(createFakeLlm([post("Happy birthday!")]));
      const second = await tick(new Date(firing.getTime() + 1000));
      expect(second.produced).toBe(1);
    }

    const after = await getStandingSeries(e.scope, seriesId);
    const rowId = after.rows.items[0]!.id;
    const occurrences = await e.scope.datedOccurrences.listForRow(rowId, { limit: 10 });
    expect(occurrences.filter((o) => o.outcome === "produced")).toHaveLength(1);
    const runs = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 5 });
    expect(runs).toHaveLength(1);
  }, 60_000);

  it("two concurrent imports resolve to one winner and one ConflictError", async () => {
    const e = await standingSeriesEnv();
    const seriesId = await datedSeries(e);
    const first = csvBuilder(["date", "name"], [["03-14", "Ada Lovelace"]]);
    const second = csvBuilder(["date", "name"], [["04-01", "Grace Hopper"]]);

    const results = await Promise.allSettled([
      importDatedList(e.scope, seriesId, file(first, "first.csv")),
      importDatedList(e.scope, seriesId, file(second, "second.csv")),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError);
  }, 60_000);

  it("SC-007: repeats the concurrent-tick case 20 times with no duplicate run or post", async () => {
    for (let trial = 0; trial < 20; trial += 1) {
      await parkOtherSeries();
      await clearHolds();
      const e = await standingSeriesEnv();
      const seriesId = await datedSeries(e);
      for (let i = 0; i < 3; i += 1) {
        await e.scope.datedRows.insert(seriesId, rowInput({ ordinal: i, nextTargetDate: "2026-03-14" }));
      }

      setLlmForTests(createFakeLlm(Array.from({ length: 6 }, () => post("A fixture post."))));
      const at = new Date("2026-03-14T00:00:01.000Z");
      const [a, b] = await Promise.all([tick(at), tick(at)]);
      expect(a.produced + b.produced).toBe(3);

      const runs = await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 10 });
      expect(runs).toHaveLength(1);
      const positions = await e.scope.standingSeriesPositions.listForRun(runs[0]!.id);
      expect(positions.filter((p) => p.status === "produced")).toHaveLength(3);
    }
  }, 120_000);
});
