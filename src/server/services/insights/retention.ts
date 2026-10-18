// services/insights/retention: the fold-and-prune housekeeping pass (contracts/fold.md §1, §5).
import { foldAndPruneAccountSnapshotsBefore, foldAndPrunePostSnapshotsBefore, type FoldAndPruneCounts } from "../../dal/insights";
import { crossProject } from "../../dal/scope";
import { insightsConfig, type SchedulerConfig } from "../../scheduler/config";
import type { ShapeFor } from "./fold";

/**
 * Folds and prunes account-metric snapshots past `INSIGHTS_RETENTION_DAYS`, one bounded batch,
 * cross-project, in a single transaction (US5, FR-050 to FR-057). Replaces the prior prune-only
 * `pruneAccountMetricSnapshots` — there is no separate fold step to order before it (contracts/fold.md
 * §1).
 */
export async function foldAndPruneAccountSnapshots(config: SchedulerConfig, now: Date, shapeFor: ShapeFor): Promise<FoldAndPruneCounts> {
  const { retentionDays, pruneBatch } = insightsConfig(config);
  const before = new Date(now.getTime() - retentionDays * 86_400_000);
  return crossProject("housekeeping: fold and prune account metric snapshots", () => foldAndPruneAccountSnapshotsBefore(before, pruneBatch, shapeFor));
}

/** Same as `foldAndPruneAccountSnapshots`, for post-target snapshots. Replaces `prunePostMetricSnapshots`. */
export async function foldAndPrunePostSnapshots(config: SchedulerConfig, now: Date, shapeFor: ShapeFor): Promise<FoldAndPruneCounts> {
  const { retentionDays, pruneBatch } = insightsConfig(config);
  const before = new Date(now.getTime() - retentionDays * 86_400_000);
  return crossProject("housekeeping: fold and prune post metric snapshots", () => foldAndPrunePostSnapshotsBefore(before, pruneBatch, shapeFor));
}
