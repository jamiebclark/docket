// services/insights/retention: the housekeeping prune pass (data-model.md §11, FR-073, FR-074).
import { prunePostMetricSnapshotsBefore, pruneAccountMetricSnapshotsBefore } from "../../dal/insights";
import { crossProject } from "../../dal/scope";
import { insightsConfig, type SchedulerConfig } from "../../scheduler/config";

/**
 * Deletes post-metric snapshots past `INSIGHTS_RETENTION_DAYS`, one bounded batch, cross-project.
 * Never touches a poll state, target, post or account (FR-074).
 */
export async function prunePostMetricSnapshots(config: SchedulerConfig, now: Date): Promise<number> {
  const { retentionDays, pruneBatch } = insightsConfig(config);
  const before = new Date(now.getTime() - retentionDays * 86_400_000);
  return crossProject("housekeeping: prune post metric snapshots", () => prunePostMetricSnapshotsBefore(before, pruneBatch));
}

/** Same as `prunePostMetricSnapshots`, for account-metric snapshots. */
export async function pruneAccountMetricSnapshots(config: SchedulerConfig, now: Date): Promise<number> {
  const { retentionDays, pruneBatch } = insightsConfig(config);
  const before = new Date(now.getTime() - retentionDays * 86_400_000);
  return crossProject("housekeeping: prune account metric snapshots", () => pruneAccountMetricSnapshotsBefore(before, pruneBatch));
}
