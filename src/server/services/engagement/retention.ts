// services/engagement/retention: the housekeeping prune pass (data-model.md §10, FR-060, FR-061).
import { pruneEngagementItemsBefore } from "../../dal/engagement";
import { crossProject } from "../../dal/scope";
import { engagementConfig, type SchedulerConfig } from "../../scheduler/config";

/**
 * Deletes items (and their drafts, by cascade) past `ENGAGEMENT_RETENTION_DAYS` with no pending
 * draft and no unresolved ambiguous send, plus any withdrawn item regardless of age. One bounded
 * batch; the ledger is never pruned.
 */
export async function pruneEngagementItems(config: SchedulerConfig, now: Date): Promise<number> {
  const { retentionDays, pruneBatch } = engagementConfig(config);
  const before = new Date(now.getTime() - retentionDays * 86_400_000);
  return crossProject("housekeeping: prune engagement items", () => pruneEngagementItemsBefore(before, pruneBatch));
}
