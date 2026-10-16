import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { apiIdempotencyKeys, standingSeriesOccurrences } from "../../../src/server/db/schema";
import { runTick } from "../../../src/server/scheduler";
import { schedulerConfig } from "../../../src/server/scheduler/config";
import { runHousekeeping, STANDING_SERIES_RUN_RETENTION_DAYS } from "../../../src/server/scheduler/housekeeping";
import { createStandingSeries } from "../../../src/server/services/standing-series/manage";
import { getEnv } from "../../../src/server/env";
import { createKey } from "../../helpers/api";
import { atTime } from "../../helpers/clock";
import { closeDb, testDb } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";
import { standingSeriesEnv } from "../../helpers/standing-series-env";

afterAll(closeDb);

const config = () => schedulerConfig(getEnv());

describe("housekeeping", () => {
  it("purges idempotency rows past their retention, across projects, and keeps live ones", async () => {
    const env = await postsEnv();
    const key = await createKey(env.scope, ["read"]);
    const claim = (idemKey: string) =>
      env.scope.idempotency.claim({ apiKeyId: key.id, method: "POST", route: "/x", idemKey, bodyHash: "h", holdMs: 1000 });
    await claim("old");
    await atTime(new Date(Date.now() + 6 * 24 * 3600_000), () => claim("recent"));

    const rows = () => testDb().select().from(apiIdempotencyKeys).where(eq(apiIdempotencyKeys.projectId, env.project.id));
    expect(await rows()).toHaveLength(2);
    // "old" is 8 days old and "recent" 2 days old at this point.
    await atTime(new Date(Date.now() + 8 * 24 * 3600_000), () => runHousekeeping(config()));
    expect((await rows()).map((r) => r.idemKey)).toEqual(["recent"]);
  });

  it("prunes closed standing-series runs past the 90-day cutoff, but never an open run", async () => {
    const e = await standingSeriesEnv();
    const { seriesId } = await createStandingSeries(e.scope, e.create());
    const old = new Date(Date.now() - (STANDING_SERIES_RUN_RETENTION_DAYS + 1) * 24 * 3600_000);
    const oldRun = await e.scope.standingSeriesRuns.openRun({
      seriesId,
      period: "day",
      periodStart: "2020-01-01",
      periodStartAt: old,
      requestedCount: 1,
      config: {},
    });
    await e.scope.standingSeriesRuns.close(oldRun.id, "produced_none", old);

    const openRun = await e.scope.standingSeriesRuns.openRun({
      seriesId,
      period: "day",
      periodStart: "2026-01-01",
      periodStartAt: new Date(),
      requestedCount: 1,
      config: {},
    });

    await runHousekeeping(config());
    expect(await e.scope.standingSeriesRuns.get(oldRun.id)).toBeNull();
    expect(await e.scope.standingSeriesRuns.get(openRun.id)).not.toBeNull();
  });

  it("prunes settled standing-series occurrences past the 90-day cutoff, but never a pending one", async () => {
    const e = await standingSeriesEnv();
    const { seriesId } = await createStandingSeries(e.scope, e.create());
    const row = await e.scope.datedRows.insert(seriesId, {
      ordinal: 1,
      month: 6,
      day: 15,
      year: null,
      keyValue: "row-1",
      fields: {},
      mediaFilename: null,
      mediaAssetId: null,
      nextTargetDate: null,
      sourceLine: 2,
    });
    const run = await e.scope.standingSeriesRuns.openRun({
      seriesId,
      period: "day",
      periodStart: "2026-01-01",
      periodStartAt: new Date(),
      requestedCount: 1,
      config: {},
    });
    const [position1, position2] = await e.scope.standingSeriesPositions.insertMany(run.id, 2, new Date());

    const old = new Date(Date.now() - (STANDING_SERIES_RUN_RETENTION_DAYS + 1) * 24 * 3600_000);
    const settledOld = await e.scope.datedOccurrences.insert({ seriesId, rowId: row.id, year: 2020, targetDate: "2020-06-15", positionId: position1!.id });
    await e.scope.datedOccurrences.settle(settledOld.id, "produced", old);
    await testDb()
      .update(standingSeriesOccurrences)
      .set({ recordedAt: old })
      .where(and(eq(standingSeriesOccurrences.projectId, e.project.id), eq(standingSeriesOccurrences.id, settledOld.id)));

    const pending = await e.scope.datedOccurrences.insert({ seriesId, rowId: row.id, year: 2019, targetDate: "2019-06-15", positionId: position2!.id });
    await testDb()
      .update(standingSeriesOccurrences)
      .set({ recordedAt: old })
      .where(and(eq(standingSeriesOccurrences.projectId, e.project.id), eq(standingSeriesOccurrences.id, pending.id)));

    await runHousekeeping(config());
    expect(await e.scope.datedOccurrences.get(settledOld.id)).toBeNull();
    expect(await e.scope.datedOccurrences.get(pending.id)).not.toBeNull();
  });

  it("is a section of the tick", async () => {
    const summary = await runTick();
    expect(summary.housekeeping.ok).toBe(true);
  });
});
