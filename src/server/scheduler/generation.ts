// scheduler/generation: the generation-jobs section of a tick (contracts/runner.md).
import * as clock from "../dal/clock";
import { writeHeartbeat } from "../dal/heartbeats";
import { anyProjectHasCredential } from "../dal/project-llm";
import { claimDueJobItems } from "../dal/job-claims";
import { getLlmStatus } from "../llm";
import { processClaimedItem } from "../services/jobs/runner";
import { jobConfig, type SchedulerConfig } from "./config";

export interface GenerationCounts {
  /** Items claimed this tick (cap: `jobMaxItems`). */
  claimed: number;
  done: number;
  failed: number;
  /** Already-posted ids caught before or during the model call. */
  skipped: number;
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
  /** `1` when the whole tick had no credential anywhere; also incremented per item whose own
   * project-and-install resolution came back unconfigured after the claim (L27). */
  notConfigured: number;
  /** The tick budget is too short for any item. */
  notRunnable: 0 | 1;
  /** Items a billing refusal sent back to the queue with no attempt counted (FR-009). */
  requeued: number;
  /** At least one credential owner was held, so its items were not claimed (FR-021). */
  held: 0 | 1;
  /** A held owner was allowed one item through as a probe this tick (FR-021). */
  probed: 0 | 1;
}

export const emptyGenerationCounts = (): GenerationCounts => ({
  claimed: 0,
  done: 0,
  failed: 0,
  skipped: 0,
  retried: 0,
  deferred: 0,
  released: 0,
  recovered: 0,
  finishing: 0,
  cancelled: 0,
  staleResults: 0,
  notConfigured: 0,
  notRunnable: 0,
  requeued: 0,
  held: 0,
  probed: 0,
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

  const claim = await claimDueJobItems({ now, limit: cfg.maxItems, leaseMs: cfg.leaseMs, maxAttempts: cfg.maxAttempts });
  counts.claimed = claim.items.length;
  counts.recovered = claim.items.filter((c) => c.recovered).length;
  counts.held = claim.held.length > 0 ? 1 : 0;
  counts.probed = claim.probing.length > 0 ? 1 : 0;
  await Promise.all(
    claim.items.map((c) =>
      processClaimedItem(c, { config: opts.config, deadline, counts }).catch(() => {
        counts.staleResults++;
      }),
    ),
  );
  await beat();
  return counts;
}
