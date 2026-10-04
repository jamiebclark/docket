import type { ApiJob, ApiJobItem, ApiJobSummary } from "@/lib/api/schemas";
import type { JobCounts, JobItemRecord, JobRecord } from "../../dal/jobs";

export function toApiJobSummary(job: JobRecord, counts: JobCounts, createdBy: ApiJobSummary["createdBy"]): ApiJobSummary {
  return {
    id: job.id,
    status: job.status,
    open: job.open,
    sourceKind: job.sourceKind,
    sourceSummary: job.sourceSummary,
    itemCount: job.itemCount,
    counts,
    approvalPolicy: job.approvalPolicy,
    schedulingPolicy: job.schedulingPolicy,
    createdBy,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt ? job.startedAt.toISOString() : null,
    finishedAt: job.finishedAt ? job.finishedAt.toISOString() : null,
    cancelledAt: job.cancelledAt ? job.cancelledAt.toISOString() : null,
  };
}

/** The one `Job` shape used by API responses and webhook event bodies. */
export function toApiJob(job: JobRecord, counts: JobCounts, createdBy: ApiJob["createdBy"]): ApiJob {
  return {
    ...toApiJobSummary(job, counts, createdBy),
    fields: job.templateFields,
    template: job.template,
    accountIds: job.targetAccountIds,
    voiceProfileId: job.voiceProfileId,
  };
}

export function toApiJobItem(
  item: JobItemRecord,
  post: { id: string; reviewState: string } | null,
): ApiJobItem {
  return {
    id: item.id,
    position: item.position,
    label: item.label,
    status: item.status,
    attempts: item.attemptCount,
    mediaId: item.mediaAssetId,
    post,
    error: item.lastErrorKind ? { kind: item.lastErrorKind, message: item.lastError ?? "" } : null,
    finishedAt: item.finishedAt ? item.finishedAt.toISOString() : null,
  };
}
