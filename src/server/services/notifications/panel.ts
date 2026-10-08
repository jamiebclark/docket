import { OUTCOME_LABEL } from "../../../lib/activity/outcomes";
import type { NotificationItem, NotificationOutcome } from "../../../lib/notifications/types";
import type { ActivityRecord } from "../../dal/activity";
import { recordAccount, recordLink, recordPlatforms, recordPostDeleted } from "../activity";

/**
 * The panel's view of one attention event, built from the same pieces Activity uses (platforms, account, link),
 * so a notification and its Activity row always agree. A project with no reading position row is never "new".
 */
export function toNotificationItem(record: ActivityRecord, seenSeqByProject: ReadonlyMap<string, bigint>): NotificationItem {
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
    isNew: seen !== undefined && BigInt(record.seq) > seen,
    link: recordLink(record),
  };
}
