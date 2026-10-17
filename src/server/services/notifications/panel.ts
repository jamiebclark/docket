import { EVENT_MARK_CAP } from "../../../lib/notifications/attention";
import { OUTCOME_LABEL } from "../../../lib/activity/outcomes";
import type { NotificationItem, NotificationOutcome } from "../../../lib/notifications/types";
import type { AttentionRecord } from "../../dal/activity";
import { recordAccount, recordLink, recordPlatforms, recordPostDeleted } from "../activity";

/**
 * The panel's view of one attention event, built from the same pieces Activity uses (platforms, account, link),
 * so a notification and its Activity row always agree. A project with no reading position row is never "new".
 */
export function toNotificationItem(
  record: AttentionRecord,
  seenSeqByProject: ReadonlyMap<string, bigint>,
  markCounts: ReadonlyMap<string, number>,
): NotificationItem {
  const seen = seenSeqByProject.get(record.projectId);
  return {
    id: record.id,
    outcome: record.outcome as NotificationOutcome,
    outcomeLabel: OUTCOME_LABEL[record.outcome],
    occurredAt: record.occurredAt.toISOString(),
    project: { slug: record.projectSlug, name: record.projectName, timeZone: record.projectTimeZone },
    platforms: recordPlatforms(record),
    accountName: recordAccount(record)?.name ?? null,
    postDeleted: recordPostDeleted(record),
    message: record.message,
    isNew: seen !== undefined && BigInt(record.seq) > seen && !record.hiddenByMark,
    // The same comparison `markEvent` makes before it writes, so the row only offers an action that
    // would do something. A project with no reading position row yet reads as seq > 0: markable.
    read: seen !== undefined && BigInt(record.seq) <= seen,
    actionsAvailable: (markCounts.get(record.projectId) ?? 0) < EVENT_MARK_CAP,
    link: recordLink(record),
  };
}
