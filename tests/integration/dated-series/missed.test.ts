import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Temporal } from "@js-temporal/polyfill";
import { setLlmForTests } from "../../../src/server/llm";
import { runStandingSeries, type StandingSeriesCounts } from "../../../src/server/scheduler/standing-series";
import type { SchedulerConfig } from "../../../src/server/scheduler/config";
import { createStandingSeries, pauseStandingSeries, resumeStandingSeries } from "../../../src/server/services/standing-series/manage";
import { getStandingSeries } from "../../../src/server/services/standing-series/read";
import { evaluateDatedSeries } from "../../../src/server/services/standing-series/dated-due";
import { getDb } from "../../../src/server/db/client";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { standingSeries } from "../../../src/server/db/schema";
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
    keyValue: "Ada Lovelace",
    fields: { name: "Ada Lovelace" },
    mediaFilename: null,
    mediaAssetId: null,
    nextTargetDate: null,
    sourceLine: over.ordinal + 2,
    ...over,
  };
}

describe("missed dated occurrences (US3 AS4-AS5, FR-034-FR-036, B25, SC-008)", () => {
  it("AS4: a row whose window closes while paused is recorded missed on Resume, with no backfill", async () => {
    const e = await standingSeriesEnv();
    const created = new Date("2026-01-01T00:00:00.000Z");
    const { seriesId } = await atTime(created, () =>
      createStandingSeries(e.scope, e.create({ occurrenceRule: "dated_list", cadence: null })),
    );
    const row = await e.scope.datedRows.insert(seriesId, rowInput({ ordinal: 0, nextTargetDate: "2026-03-14" }));

    await atTime(new Date("2026-03-01T00:00:00.000Z"), () => pauseStandingSeries(e.scope, seriesId));

    const resumedAt = new Date("2026-03-20T00:00:00.000Z");
    await atTime(resumedAt, () => resumeStandingSeries(e.scope, seriesId));

    const occurrences = await e.scope.datedOccurrences.listForRow(row.id, { limit: 5 });
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]!.outcome).toBe("missed");
    expect(occurrences[0]!.targetDate).toBe("2026-03-14");

    const detail = await getStandingSeries(e.scope, seriesId);
    const view = detail.rows.items.find((r) => r.id === row.id)!;
    expect(view.nextTargetDate).toBe("2027-03-14");
    expect(view.lastOutcome).toBe("missed");

    // No backfill: a tick right after resume produces nothing for the date that already passed.
    setLlmForTests(createFakeLlm([post("Should not run.")]));
    const after = await tick(resumedAt);
    expect(after.produced).toBe(0);
    expect(await e.scope.standingSeriesRuns.listForSeries(seriesId, { limit: 5 })).toHaveLength(0);
  });

  it("AS5: a worker down for all of the date records missed with no lead time, but has already produced with a 3-day lead", async () => {
    const noLead = await standingSeriesEnv();
    const created = new Date("2026-01-01T00:00:00.000Z");
    const { seriesId: noLeadId } = await atTime(created, () =>
      createStandingSeries(noLead.scope, noLead.create({ occurrenceRule: "dated_list", cadence: null, leadDays: 0 })),
    );
    const noLeadRow = await noLead.scope.datedRows.insert(noLeadId, rowInput({ ordinal: 0, nextTargetDate: "2026-03-14" }));

    const leaded = await standingSeriesEnv();
    const { seriesId: leadedId } = await atTime(created, () =>
      createStandingSeries(leaded.scope, leaded.create({ occurrenceRule: "dated_list", cadence: null, leadDays: 3 })),
    );
    const leadedRow = await leaded.scope.datedRows.insert(leadedId, rowInput({ ordinal: 0, nextTargetDate: "2026-03-14" }));

    // The lead series' window opens on 11 March, three days early; the worker is then down for all
    // of 14 March and comes back on 15 March.
    setLlmForTests(createFakeLlm([post("Produced three days early.")]));
    const early = await tick(new Date("2026-03-11T00:00:01.000Z"));
    expect(early.produced).toBe(1);
    expect(await leaded.scope.standingSeriesRuns.listForSeries(leadedId, { limit: 5 })).toHaveLength(1);

    setLlmForTests(createFakeLlm([post("Should not run.")]));
    const comeback = await tick(new Date("2026-03-15T00:00:01.000Z"));
    expect(comeback.produced).toBe(0);

    const noLeadOccurrences = await noLead.scope.datedOccurrences.listForRow(noLeadRow.id, { limit: 5 });
    expect(noLeadOccurrences).toHaveLength(1);
    expect(noLeadOccurrences[0]!.outcome).toBe("missed");

    const leadedOccurrences = await leaded.scope.datedOccurrences.listForRow(leadedRow.id, { limit: 5 });
    expect(leadedOccurrences).toHaveLength(1);
    expect(leadedOccurrences[0]!.outcome).toBe("produced");
  });

  it("FR-036/B25: the bounded sweep processes at most 50 rows per pass, advancing every stale next_target_date even outside the 30-day missed window", async () => {
    const e = await standingSeriesEnv();
    const created = new Date("2026-01-01T00:00:00.000Z");
    const { seriesId } = await atTime(created, () =>
      createStandingSeries(e.scope, e.create({ occurrenceRule: "dated_list", cadence: null })),
    );

    const today = Temporal.PlainDate.from("2026-05-01");
    const TOTAL = 55;
    for (let i = 0; i < TOTAL; i++) {
      const daysAgo = i + 1; // 1..55 days before "today", so row 39 is exactly 40 days old.
      await e.scope.datedRows.insert(
        seriesId,
        rowInput({ ordinal: i, keyValue: `Row ${i}`, fields: { name: `Row ${i}` }, nextTargetDate: today.subtract({ days: daysAgo }).toString() }),
      );
    }

    const series = (await e.scope.standingSeries.get(seriesId))!;
    const now = new Date("2026-05-01T12:00:00.000Z");

    // First pass: the DAL fetches the 50 oldest rows (daysAgo 55..6); of those, the 25 within the
    // 30-day window (daysAgo 30..6) are recorded missed, and the 25 outside it (daysAgo 55..31,
    // including the 40-day-old row) are retired without a missed occurrence.
    const firstPass = await evaluateDatedSeries(e.scope, series, now);
    expect(firstPass.retired).toBe(50);
    expect(firstPass.missed).toBe(25);

    const fortyDaysOld = (await e.scope.datedRows.listForSeries(seriesId)).find((r) => r.keyValue === "Row 39")!;
    expect(fortyDaysOld.nextTargetDate).not.toBe(today.subtract({ days: 40 }).toString());
    const fortyDaysOldOccurrences = await e.scope.datedOccurrences.listForRow(fortyDaysOld.id, { limit: 5 });
    expect(fortyDaysOldOccurrences).toHaveLength(0);

    const stillStale = (await e.scope.datedRows.listForSeries(seriesId)).filter(
      (r) => r.nextTargetDate !== null && r.nextTargetDate < "2026-05-01",
    );
    expect(stillStale).toHaveLength(5); // daysAgo 5..1, not reached this pass

    const secondPass = await evaluateDatedSeries(e.scope, series, now);
    expect(secondPass.retired).toBe(5);
    expect(secondPass.missed).toBe(5);

    const occurrences = await e.scope.datedOccurrences.listForSeries(seriesId, { limit: 100 });
    expect(occurrences.filter((o) => o.outcome === "missed")).toHaveLength(30);
  });
});
