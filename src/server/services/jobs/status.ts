// jobs/status: a job's status is derived from its items and written only here (research D10).
import * as clock from "../../dal/clock";
import type { JobCounts, JobRecord, JobStatus } from "../../dal/jobs";
import type { ProjectScope } from "../../dal/scope";

/**
 * The status a job should have. `cancelled` is final. Otherwise: any queued or running item means the job
 * is still going (`queued` until work has started, then `running`); with none left it is `completed`, or
 * `completed_with_failures` when any item failed.
 */
export function deriveJobStatus(current: JobStatus, counts: JobCounts, started: boolean): JobStatus {
  if (current === "cancelled") return "cancelled";
  if (counts.queued + counts.running > 0) {
    return started || counts.running > 0 || counts.done + counts.failed > 0 ? "running" : "queued";
  }
  return counts.failed > 0 ? "completed_with_failures" : "completed";
}

/** Recomputes and writes the job's status and timestamps. Call inside a transaction that holds (or takes) the job lock. */
export async function refreshJobStatus(tx: ProjectScope, jobId: string): Promise<JobRecord> {
  const job = await tx.jobs.lockForUpdate(jobId);
  if (!job) throw new Error("Job not found");
  const counts = await tx.jobItems.countByStatus(jobId);
  const next = deriveJobStatus(job.status, counts, job.startedAt !== null);
  const finished = next === "completed" || next === "completed_with_failures";
  const patch: Parameters<ProjectScope["jobs"]["update"]>[1] = {};
  if (next !== job.status) patch.status = next;
  if (next !== "queued" && next !== "cancelled" && job.startedAt === null) patch.startedAt = await clock.now();
  if (finished && job.finishedAt === null) patch.finishedAt = await clock.now();
  if (!finished && job.finishedAt !== null) patch.finishedAt = null;
  if (Object.keys(patch).length === 0) return job;
  return (await tx.jobs.update(jobId, patch)) ?? job;
}
