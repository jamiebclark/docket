import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, lte, or, sql } from "drizzle-orm";
import { getDb, type Database } from "../db/client";
import { generationJobItems, generationJobs, posts } from "../db/schema";
import { credentialOwnerFor, credentialOwnersFor, INSTALL_CREDENTIAL_OWNER, jobsExcludingProjects } from "./credential-owners";
import { gateCreditHolds, rewindCreditProbe } from "./credit-holds";
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
  /** This job's credential owner, from the one named seam (FR-012). */
  owner: string;
  /** This item is the one a held owner was allowed through as a probe (FR-014). */
  probe: boolean;
}

export interface ClaimResult {
  items: ClaimedJobItem[];
  /** Owners that had a hold at claim time (FR-021). */
  held: string[];
  /** Those granted this tick's probe; `probing ⊆ held`. */
  probing: string[];
}

export const INTERRUPTED_MESSAGE = "Generation was interrupted too many times.";

/**
 * Resolves `owners` to the project ids of their currently active (`queued`/`running`) jobs, by asking
 * `credentialOwnersFor` about all candidate projects in one round trip — a genuine per-owner lookup rather
 * than an all-or-nothing guess (SC-010), whose statement count no longer grows with project count.
 */
async function resolveBlockedProjectIds(
  exec: Database,
  owners: readonly string[],
): Promise<{ ids: string[]; allBlocked: boolean }> {
  if (owners.length === 0) return { ids: [], allBlocked: false };
  const blocked = new Set(owners);
  const rows = await exec
    .selectDistinct({ projectId: generationJobs.projectId })
    .from(generationJobs)
    .where(inArray(generationJobs.status, ["queued", "running"]));
  const projectIds = rows.map((r) => r.projectId);
  const ownersByProject = await credentialOwnersFor(projectIds, exec);
  const ids = projectIds.filter((id) => blocked.has(ownersByProject.get(id) ?? INSTALL_CREDENTIAL_OWNER));
  return { ids, allBlocked: ids.length > 0 && ids.length === projectIds.length };
}

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
}): Promise<ClaimResult> {
  return crossProject("scheduler: claim due job items", async () => {
    if (opts.limit <= 0) return { items: [], held: [], probing: [] };
    const { now } = opts;
    return getDb().transaction(async (tx) => {
      const exec = tx as unknown as Database;
      const { held, probing } = await gateCreditHolds(exec, now);
      const probingSet = new Set(probing);
      const blocked = held.filter((o) => !probingSet.has(o));
      const blockedProjects = await resolveBlockedProjectIds(exec, blocked);

      const queuedDue = and(eq(generationJobItems.status, "queued"), lte(generationJobItems.nextAttemptAt, now));
      const itemDue = or(queuedDue, and(eq(generationJobItems.status, "running"), lte(generationJobItems.leaseUntil, now)));
      const jobs = await exec
        .select()
        .from(generationJobs)
        .where(
          and(
            inArray(generationJobs.status, ["queued", "running"]),
            sql`EXISTS (SELECT 1 FROM "generation_job_items" "i" WHERE "i"."project_id" = ${generationJobs.projectId} AND "i"."job_id" = ${generationJobs.id} AND (("i"."status" = 'queued' AND "i"."next_attempt_at" <= ${now}) OR ("i"."status" = 'running' AND "i"."lease_until" <= ${now})))`,
            jobsExcludingProjects(blockedProjects.ids, blockedProjects.allBlocked),
          ),
        )
        .orderBy(sql`${generationJobs.lastClaimedAt} ASC NULLS FIRST`, asc(generationJobs.createdAt), asc(generationJobs.id))
        .limit(opts.limit)
        .for("update", { skipLocked: true });
      if (jobs.length === 0) {
        for (const owner of probing) await rewindCreditProbe(owner, now, exec);
        return { items: [], held, probing };
      }

      const jobOwners = new Map<string, string>();
      for (const job of jobs) jobOwners.set(job.id, await credentialOwnerFor(job.projectId));

      const perJob: { job: JobRecord; owner: string; items: JobItemRecord[] }[] = [];
      for (const job of jobs) {
        const owner = jobOwners.get(job.id)!;
        const items = await exec
          .select()
          .from(generationJobItems)
          .where(and(eq(generationJobItems.projectId, job.projectId), eq(generationJobItems.jobId, job.id), itemDue))
          .orderBy(asc(generationJobItems.position))
          .limit(opts.limit)
          .for("update", { skipLocked: true });
        perJob.push({ job, owner, items });
      }

      const budgetFor = (owner: string) => (probingSet.has(owner) ? 1 : opts.limit);
      const kept: { job: JobRecord; owner: string; item: JobItemRecord }[] = [];
      const keptPerOwner = new Map<string, number>();
      for (let round = 0; kept.length < opts.limit; round++) {
        let any = false;
        for (const { job, owner, items } of perJob) {
          const item = items[round];
          if (!item) continue;
          any = true;
          const budget = budgetFor(owner);
          const soFar = keptPerOwner.get(owner) ?? 0;
          if (kept.length < opts.limit && soFar < budget) {
            kept.push({ job, owner, item });
            keptPerOwner.set(owner, soFar + 1);
          }
        }
        if (!any) break;
      }

      const claimed: ClaimedJobItem[] = [];
      const touched = new Map<string, string>();
      for (const { job, owner, item } of kept) {
        const repo = createJobItemsRepo(exec, job.projectId);
        const lease = { leaseOwner: randomUUID(), leaseUntil: new Date(now.getTime() + opts.leaseMs) };
        const probe = probingSet.has(owner);
        touched.set(job.id, job.projectId);
        if (item.status === "queued") {
          const updated = await repo.update(item.id, { status: "running", ...lease, startedAt: item.startedAt ?? now });
          claimed.push({ item: updated, job, token: lease.leaseOwner, kind: "run", recovered: false, owner, probe });
          continue;
        }
        const [{ n } = { n: 0 }] = await exec
          .select({ n: sql<number>`count(*)::int` })
          .from(posts)
          .where(and(eq(posts.projectId, job.projectId), eq(posts.generationJobItemId, item.id)));
        if (n > 0) {
          const updated = await repo.update(item.id, lease);
          claimed.push({ item: updated, job, token: lease.leaseOwner, kind: "finish", recovered: true, owner, probe });
        } else if (!probe && item.attemptCount + 1 >= opts.maxAttempts) {
          await repo.update(item.id, {
            status: "failed",
            leaseOwner: null,
            leaseUntil: null,
            pendingRetry: null,
            lastErrorKind: "interrupted",
            lastError: INTERRUPTED_MESSAGE,
            finishedAt: now,
          });
        } else {
          // A probe claim must not increment attemptCount and must not fail the item as interrupted (US1 AS5).
          const patch = probe ? lease : { attemptCount: item.attemptCount + 1, ...lease };
          const updated = await repo.update(item.id, patch);
          claimed.push({ item: updated, job, token: lease.leaseOwner, kind: "run", recovered: true, owner, probe });
        }
      }

      for (const [jobId, projectId] of touched) {
        await createJobsRepo(exec, projectId).update(jobId, { lastClaimedAt: now });
        const slim = { jobs: createJobsRepo(exec, projectId), jobItems: createJobItemsRepo(exec, projectId), webhooks: createWebhooksRepo(exec, projectId) };
        await refreshJobStatus(slim as unknown as ProjectScope, jobId);
      }

      const keptOwners = new Set(kept.map((k) => k.owner));
      for (const owner of probing) {
        if (!keptOwners.has(owner)) await rewindCreditProbe(owner, now, exec);
      }

      return { items: claimed, held, probing };
    });
  });
}
