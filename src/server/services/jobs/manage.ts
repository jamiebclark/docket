// jobs/manage: retry and cancel a job's items. Each runs in one transaction: permission, job lock, items, status.
import * as clock from "../../dal/clock";
import { NotFoundError } from "../../dal/errors";
import type { ProjectScope } from "../../dal/scope";
import { need } from "../generation/single";
import { refreshJobStatus } from "./status";

export type ManageResult = { changed: true; message: string } | { changed: false; message: string };

const CANCELLED_MESSAGE = "This job was cancelled; its items cannot be retried.";

async function lockJob(tx: ProjectScope, jobId: string) {
  need(tx, { generation: ["run"], post: ["edit"] });
  const job = await tx.jobs.lockForUpdate(jobId);
  if (!job) throw new NotFoundError("Job not found");
  return job;
}

/** Puts one failed item back in the queue with its attempts reset. */
export async function retryItem(scope: ProjectScope, jobId: string, itemId: string): Promise<ManageResult> {
  need(scope, { generation: ["run"], post: ["edit"] });
  return scope.transaction(async (tx) => {
    const job = await lockJob(tx, jobId);
    if (job.status === "cancelled") return { changed: false, message: CANCELLED_MESSAGE };
    const item = await tx.jobItems.get(itemId);
    if (!item || item.jobId !== jobId) throw new NotFoundError("Item not found");
    if (item.status !== "failed") return { changed: false, message: "Only failed items can be retried." };
    await tx.jobItems.retryFailed(jobId, await clock.now(), itemId);
    await refreshJobStatus(tx, jobId);
    return { changed: true, message: `Item ${item.position + 1} will be retried.` };
  });
}

/** Retries every failed item of the job. */
export async function retryFailedItems(scope: ProjectScope, jobId: string): Promise<ManageResult & { count: number }> {
  need(scope, { generation: ["run"], post: ["edit"] });
  return scope.transaction(async (tx) => {
    const job = await lockJob(tx, jobId);
    if (job.status === "cancelled") return { changed: false, message: CANCELLED_MESSAGE, count: 0 };
    const ids = await tx.jobItems.retryFailed(jobId, await clock.now());
    if (ids.length === 0) return { changed: false, message: "There are no failed items to retry.", count: 0 };
    await refreshJobStatus(tx, jobId);
    return { changed: true, message: ids.length === 1 ? "1 item will be retried." : `${ids.length} items will be retried.`, count: ids.length };
  });
}

/**
 * Cancels a job: every queued, failed and running-without-post item becomes `cancelled`, which releases its image
 * (a reservation is an item in queued/running/failed). Items that already saved a post finish on their own.
 * The runner's save and policy guards re-read the job under its lock, so an in-flight item sees this.
 */
export async function cancelJob(scope: ProjectScope, jobId: string): Promise<ManageResult & { count: number }> {
  need(scope, { generation: ["run"], post: ["edit"] });
  return scope.transaction(async (tx) => {
    const job = await lockJob(tx, jobId);
    if (job.status === "cancelled") return { changed: false, message: "This job is already cancelled.", count: 0 };
    if (job.status === "completed" || job.status === "completed_with_failures") {
      return { changed: false, message: "This job has already finished.", count: 0 };
    }
    const now = await clock.now();
    const count = await tx.jobItems.cancelForJob(jobId, now);
    await tx.jobs.update(jobId, { status: "cancelled", cancelledAt: now, cancelledByUserId: tx.membership.userId, finishedAt: now });
    return { changed: true, message: count === 1 ? "Cancelled 1 item." : `Cancelled ${count} items.`, count };
  });
}
