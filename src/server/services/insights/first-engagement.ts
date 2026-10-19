// services/insights/first-engagement: the bounded housekeeping step that records, once per
// published target, when engagement was first observed (contracts/first-engagement.md §1).
import { findProvider } from "../../../providers/registry";
import {
  advanceFirstEngagementScannedThrough,
  casFirstEngagementBound,
  casFirstEngagementExact,
  claimFirstEngagementBatch,
  earliestInboxSaidAt,
  ensureFirstEngagementRows,
  postSnapshotsAscendingAfter,
} from "../../dal/insights";
import { crossProject } from "../../dal/scope";
import { insightsConfig, type SchedulerConfig } from "../../scheduler/config";

export interface FirstEngagementCounts {
  /** Figures written this pass (data-model.md §8, FR-055). */
  recorded: number;
  /** Targets examined this pass, so a pass that recorded nothing is still visible. */
  scanned: number;
}

/** Whether `metrics` declares any of `providerKey`'s post metric keys above zero. */
function hasDeclaredEngagement(providerKey: string, metrics: Record<string, unknown>): boolean {
  const declared = findProvider(providerKey)?.insights?.declaration.post ?? [];
  for (const key of declared) {
    const value = metrics[key.key];
    if (typeof value === "number" && value > 0) return true;
  }
  return false;
}

/**
 * The only writer of `target_first_engagement` (contracts/first-engagement.md §1). Reuses
 * `INSIGHTS_PRUNE_BATCH` rather than a new environment variable. Runs before `pruneEngagementItems`
 * in the same housekeeping pass, for the same reason the fold runs before its own delete.
 */
export async function recordFirstEngagement(config: SchedulerConfig, now: Date): Promise<FirstEngagementCounts> {
  void now;
  const { pruneBatch } = insightsConfig(config);
  await crossProject("housekeeping: ensure first-engagement rows", () => ensureFirstEngagementRows(pruneBatch));
  const targets = await crossProject("housekeeping: claim first-engagement batch", () => claimFirstEngagementBatch(pruneBatch));

  let recorded = 0;
  for (const target of targets) {
    let didRecord = false;

    const said = await crossProject("housekeeping: first-engagement exact read", () =>
      earliestInboxSaidAt(target.projectId, target.postTargetId, target.publishedAt),
    );
    if (said) {
      await crossProject("housekeeping: first-engagement exact write", () =>
        casFirstEngagementExact(target.postTargetId, target.projectId, said),
      );
      didRecord = true;
    }

    if (!target.boundBeforeAt) {
      const after = target.scannedThrough ?? target.publishedAt;
      const snapshots = await crossProject("housekeeping: first-engagement snapshot read", () =>
        postSnapshotsAscendingAfter(target.projectId, target.postTargetId, after),
      );
      if (snapshots.length > 0) {
        let previousCapturedAt: Date | null = null;
        let found: { capturedAt: Date; boundAfterAt: Date | null } | null = null;
        for (const snapshot of snapshots) {
          if (!found && hasDeclaredEngagement(snapshot.providerKey, snapshot.metrics)) {
            found = { capturedAt: snapshot.capturedAt, boundAfterAt: previousCapturedAt };
          }
          previousCapturedAt = snapshot.capturedAt;
        }
        if (found) {
          await crossProject("housekeeping: first-engagement bound write", () =>
            casFirstEngagementBound(target.postTargetId, target.projectId, found!.capturedAt, found!.boundAfterAt),
          );
          didRecord = true;
        }
        const newestCapturedAt = snapshots[snapshots.length - 1]!.capturedAt;
        await crossProject("housekeeping: first-engagement watermark", () =>
          advanceFirstEngagementScannedThrough(target.postTargetId, target.projectId, newestCapturedAt),
        );
      }
    }

    if (didRecord) recorded++;
  }

  return { recorded, scanned: targets.length };
}
