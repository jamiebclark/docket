import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, lte, or, sql } from "drizzle-orm";
import { getDb, type Database } from "../db/client";
import { generationJobItems, generationJobs, posts } from "../db/schema";
import { createWebhooksRepo } from "./webhooks";
import { refreshJobStatus } from "../services/jobs/status";
import { createJobItemsRepo, createJobsRepo, type JobItemRecord, type JobRecord } from "./jobs";
import { crossProject, type ProjectScope } from "./scope";

export { forJobRunner } from "./scope";

export interface ClaimedJobItem {
  /** After the claim patch. */
  item: JobItemRecord;
  /** The locked job row at claim time. */
  job: JobRecord;
  /** The `lease_owner` written by this claim. */
  token: string;
  /** `finish`: the item already has a post, so no model call is made. */
  kind: "run" | "finish";
  /** The lease had expired. */
  recovered: boolean;
}

export const INTERRUPTED_MESSAGE = "Generation was interrupted too many times.";

/**
 * Claims due job items (research D4): lock up to `limit` jobs that have a due item (`SKIP LOCKED`, least recently
 * served first), lock their due items in position order, interleave the jobs round-robin, keep `limit`, and apply
 * the claim decision to each. One transaction; never waits.
 */
export function claimDueJobItems(opts: {
  now: Date;
  limit: number;
  leaseMs: number;
  maxAttempts: number;
}): Promise<ClaimedJobItem[]> {
  return crossProject("scheduler: claim due job items", async () => {
    if (opts.limit <= 0) return [];
    const { now } = opts;
    return getDb().transaction(async (tx) => {
      const exec = tx as unknown as Database;
      const itemDue = or(
        and(eq(generationJobItems.status, "queued"), lte(generationJobItems.nextAttemptAt, now)),
        and(eq(generationJobItems.status, "running"), lte(generationJobItems.leaseUntil, now)),
      );
      const jobs = await exec
        .select()
        .from(generationJobs)
        .where(
          and(
            inArray(generationJobs.status, ["queued", "running"]),
            sql`EXISTS (SELECT 1 FROM "generation_job_items" "i" WHERE "i"."project_id" = ${generationJobs.projectId} AND "i"."job_id" = ${generationJobs.id} AND (("i"."status" = 'queued' AND "i"."next_attempt_at" <= ${now}) OR ("i"."status" = 'running' AND "i"."lease_until" <= ${now})))`,
          ),
        )
        .orderBy(sql`${generationJobs.lastClaimedAt} ASC NULLS FIRST`, asc(generationJobs.createdAt), asc(generationJobs.id))
        .limit(opts.limit)
        .for("update", { skipLocked: true });
      if (jobs.length === 0) return [];

      const perJob: { job: JobRecord; items: JobItemRecord[] }[] = [];
      for (const job of jobs) {
        const items = await exec
          .select()
          .from(generationJobItems)
          .where(and(eq(generationJobItems.projectId, job.projectId), eq(generationJobItems.jobId, job.id), itemDue))
          .orderBy(asc(generationJobItems.position))
          .limit(opts.limit)
          .for("update", { skipLocked: true });
        perJob.push({ job, items });
      }

      // Round robin: the first item of each job, then the second of each …
      const kept: { job: JobRecord; item: JobItemRecord }[] = [];
      for (let round = 0; kept.length < opts.limit; round++) {
        let any = false;
        for (const { job, items } of perJob) {
          const item = items[round];
          if (!item) continue;
          any = true;
          if (kept.length < opts.limit) kept.push({ job, item });
        }
        if (!any) break;
      }

      const claimed: ClaimedJobItem[] = [];
      const touched = new Map<string, string>();
      for (const { job, item } of kept) {
        const repo = createJobItemsRepo(exec, job.projectId);
        const lease = { leaseOwner: randomUUID(), leaseUntil: new Date(now.getTime() + opts.leaseMs) };
        touched.set(job.id, job.projectId);
        if (item.status === "queued") {
          const updated = await repo.update(item.id, { status: "running", ...lease, startedAt: item.startedAt ?? now });
          claimed.push({ item: updated, job, token: lease.leaseOwner, kind: "run", recovered: false });
          continue;
        }
        const [{ n } = { n: 0 }] = await exec
          .select({ n: sql<number>`count(*)::int` })
          .from(posts)
          .where(and(eq(posts.projectId, job.projectId), eq(posts.generationJobItemId, item.id)));
        if (n > 0) {
          const updated = await repo.update(item.id, lease);
          claimed.push({ item: updated, job, token: lease.leaseOwner, kind: "finish", recovered: true });
        } else if (item.attemptCount + 1 < opts.maxAttempts) {
          const updated = await repo.update(item.id, { attemptCount: item.attemptCount + 1, ...lease });
          claimed.push({ item: updated, job, token: lease.leaseOwner, kind: "run", recovered: true });
        } else {
          await repo.update(item.id, {
            status: "failed",
            leaseOwner: null,
            leaseUntil: null,
            pendingRetry: null,
            lastErrorKind: "interrupted",
            lastError: INTERRUPTED_MESSAGE,
            finishedAt: now,
          });
        }
      }

      for (const [jobId, projectId] of touched) {
        await createJobsRepo(exec, projectId).update(jobId, { lastClaimedAt: now });
        const slim = { jobs: createJobsRepo(exec, projectId), jobItems: createJobItemsRepo(exec, projectId), webhooks: createWebhooksRepo(exec, projectId) };
        await refreshJobStatus(slim as unknown as ProjectScope, jobId);
      }
      return claimed;
    });
  });
}
