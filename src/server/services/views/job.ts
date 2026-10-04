import type { ApiJob, ApiJobItem, ApiJobSummary } from "@/lib/api/schemas";
import type { JobCounts, JobRecord } from "../../dal/jobs";
import type { JobItemView, JobListItem } from "../jobs/read";

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

/** A `JobSummary` from the job list service's row (FR-044: the API maps service results). */
export function toApiJobSummaryFromList(job: JobListItem): ApiJobSummary {
  const createdBy: ApiJobSummary["createdBy"] = job.createdByKey
    ? { type: "api_key", name: job.createdByKey.name }
    : job.createdBy
      ? { type: "user", name: job.createdBy.name }
      : null;
  return {
    id: job.id,
    status: job.status,
    open: job.open,
    sourceKind: job.sourceKind,
    sourceSummary: job.sourceSummary,
    itemCount: job.itemCount,
    counts: job.counts,
    approvalPolicy: job.approval,
    schedulingPolicy: job.scheduling,
    createdBy,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt ? job.startedAt.toISOString() : null,
    finishedAt: job.finishedAt ? job.finishedAt.toISOString() : null,
    cancelledAt: job.cancelledAt ? job.cancelledAt.toISOString() : null,
  };
}

/** A `JobItem` from the job item read services' view. */
export function toApiJobItem(item: JobItemView): ApiJobItem {
  return {
    id: item.id,
    position: item.position,
    label: item.label,
    status: item.status,
    attempts: item.attemptCount,
    mediaId: item.mediaId,
    post: item.post ? { id: item.post.id, reviewState: item.post.reviewState } : null,
    error: item.error,
    finishedAt: item.finishedAt ? item.finishedAt.toISOString() : null,
  };
}
