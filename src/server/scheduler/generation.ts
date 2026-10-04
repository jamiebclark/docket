// scheduler/generation: the generation-jobs section of a tick (contracts/runner.md).
import * as clock from "../dal/clock";
import { writeHeartbeat } from "../dal/heartbeats";
import { claimDueJobItems } from "../dal/job-claims";
import { getLlmStatus } from "../llm";
import { processClaimedItem } from "../services/jobs/runner";
import { jobConfig, type SchedulerConfig } from "./config";

export interface GenerationCounts {
  /** Items claimed this tick (cap: `jobMaxItems`). */
  claimed: number;
  done: number;
  failed: number;
  /** Temporary failures sent back to `queued` with backoff. */
  retried: number;
  /** Correction retries deferred to a later tick (no attempt counted). */
  deferred: number;
  /** Items released uncounted (image preparation or variant warm-up overran). */
  released: number;
  /** Expired leases picked up. */
  recovered: number;
  /** Items finished without a model call (already had a post). */
  finishing: number;
  /** In-flight items whose job was cancelled. */
  cancelled: number;
  /** Lease lost before persisting. */
  staleResults: number;
  notConfigured: 0 | 1;
  /** The tick budget is too short for any item. */
  notRunnable: 0 | 1;
}

export const emptyGenerationCounts = (): GenerationCounts => ({
  claimed: 0,
  done: 0,
  failed: 0,
  retried: 0,
  deferred: 0,
  released: 0,
  recovered: 0,
  finishing: 0,
  cancelled: 0,
  staleResults: 0,
  notConfigured: 0,
  notRunnable: 0,
});

/** Claims up to `jobMaxItems` due items and processes them concurrently, each isolated from the others. */
export async function runGenerationJobs(opts: {
  config: SchedulerConfig;
  tickId: string;
  startedAt: Date;
}): Promise<GenerationCounts> {
  const cfg = jobConfig(opts.config);
  const counts = emptyGenerationCounts();
  const deadline = opts.startedAt.getTime() + cfg.timeBudgetMs;
  const beat = async () => writeHeartbeat("generation", await clock.now(), { ...counts });

  if (!getLlmStatus().configured) {
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

  const claimed = await claimDueJobItems({ now, limit: cfg.maxItems, leaseMs: cfg.leaseMs, maxAttempts: cfg.maxAttempts });
  counts.claimed = claimed.length;
  counts.recovered = claimed.filter((c) => c.recovered).length;
  await Promise.all(
    claimed.map((c) =>
      processClaimedItem(c, { config: opts.config, deadline, counts }).catch(() => {
        counts.staleResults++;
      }),
    ),
  );
  await beat();
  return counts;
}
