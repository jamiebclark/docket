// scheduler/standing-series: the standing-series section of a tick (contracts/worker.md §1).
import * as clock from "../dal/clock";
import { writeHeartbeat } from "../dal/heartbeats";
import { anyProjectHasCredential } from "../dal/project-llm";
import { claimDueStandingSeries } from "../dal/standing-series-claims";
import { getLlmStatus } from "../llm";
import { processClaimedSeries, emptyStandingSeriesCounts, type StandingSeriesCounts } from "../services/standing-series/runner";
import { standingSeriesConfig, type SchedulerConfig } from "./config";

export type { StandingSeriesCounts } from "../services/standing-series/runner";
export { emptyStandingSeriesCounts } from "../services/standing-series/runner";

/** Claims up to `maxSeries` due standing series and processes them concurrently, each isolated from the others. */
export async function runStandingSeries(opts: { config: SchedulerConfig; tickId: string; startedAt: Date }): Promise<StandingSeriesCounts> {
  const cfg = standingSeriesConfig(opts.config);
  const counts: StandingSeriesCounts = emptyStandingSeriesCounts();
  const deadline = opts.startedAt.getTime() + cfg.timeBudgetMs;
  const beat = async () => writeHeartbeat("standing_series", await clock.now(), { ...counts });

  if (!getLlmStatus().configured && !(await anyProjectHasCredential())) {
    counts.notConfigured = 1;
    await beat();
    return counts;
  }
  const needed = cfg.minCallMs + cfg.persistReserveMs;
  if (cfg.timeBudgetMs < needed) {
    counts.notRunnable = 1;
    await beat();
    return counts;
  }
  const now = await clock.now();
  if (now.getTime() + needed > deadline) {
    await beat();
    return counts;
  }

  const claim = await claimDueStandingSeries({ now, limit: cfg.maxSeries, leaseMs: cfg.leaseMs, maxAttempts: cfg.maxAttempts });
  counts.claimed = claim.series.length;
  counts.recovered = claim.series.filter((c) => c.recovered).length;
  counts.held = claim.held.length > 0 ? 1 : 0;

  await Promise.all(
    claim.series.map((c) =>
      processClaimedSeries(c, { config: opts.config, deadline, counts }).catch(() => {
        counts.staleResults++;
      }),
    ),
  );
  await beat();
  return counts;
}
