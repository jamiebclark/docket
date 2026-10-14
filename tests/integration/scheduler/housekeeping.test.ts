import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { apiIdempotencyKeys } from "../../../src/server/db/schema";
import { runTick } from "../../../src/server/scheduler";
import { runHousekeeping, STANDING_SERIES_RUN_RETENTION_DAYS } from "../../../src/server/scheduler/housekeeping";
import { createStandingSeries } from "../../../src/server/services/standing-series/manage";
import { createKey } from "../../helpers/api";
import { atTime } from "../../helpers/clock";
import { closeDb, testDb } from "../../helpers/db";
import { postsEnv } from "../../helpers/posts-env";
import { standingSeriesEnv } from "../../helpers/standing-series-env";

afterAll(closeDb);

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
    await atTime(new Date(Date.now() + 8 * 24 * 3600_000), () => runHousekeeping());
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

    await runHousekeeping();
    expect(await e.scope.standingSeriesRuns.get(oldRun.id)).toBeNull();
    expect(await e.scope.standingSeriesRuns.get(openRun.id)).not.toBeNull();
  });

  it("is a section of the tick", async () => {
    const summary = await runTick();
    expect(summary.housekeeping.ok).toBe(true);
  });
});
