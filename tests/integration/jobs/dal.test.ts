import { afterAll, describe, expect, it } from "vitest";
import { createJobItemsRepo, createJobsRepo } from "../../../src/server/dal/jobs";
import { createMediaRepo } from "../../../src/server/dal/media";
import { getDb } from "../../../src/server/db/client";
import { projectOwnedTables } from "../../../src/server/db/project-owned";
import { checkScope } from "../../helpers/scope-check";
import { closeDb } from "../../helpers/db";
import { createImageAssets, createJob, createProject, csvBuilder } from "../../helpers/factories";

afterAll(async () => {
  await closeDb();
});

describe("job schema and repositories", () => {
  it("pins the job tables by project in the scope check", () => {
    for (const table of ["generation_jobs", "generation_job_items"]) {
      expect(projectOwnedTables.some((t) => t.table === table && t.scopeColumn === "project_id")).toBe(true);
      expect(checkScope([{ sql: `select * from "${table}" where "id" = $1` }], projectOwnedTables).violations).toHaveLength(1);
      expect(
        checkScope([{ sql: `select * from "${table}" where "${table}"."project_id" = $1` }], projectOwnedTables).violations,
      ).toEqual([]);
    }
  });

  it("counts items by status for one job and many jobs", async () => {
    const project = await createProject();
    const { job } = await createJob(project.id, { items: 3 });
    const items = createJobItemsRepo(getDb(), project.id);
    expect((await items.countByStatus(job.id)).queued).toBe(3);
    const counts = await createJobsRepo(getDb(), project.id).countsFor([job.id]);
    expect(counts.get(job.id)).toMatchObject({ queued: 3, done: 0 });
  });

  it("reserves an image once while its item is queued, running or failed", async () => {
    const project = await createProject();
    const [asset] = await createImageAssets(project.id, 1);
    const media = createMediaRepo(getDb(), project.id);
    expect(await media.reservedAmong([asset!.id])).toEqual([]);
    const a = await createJob(project.id, { items: 1, itemOverrides: () => ({ mediaAssetId: asset!.id }) });
    expect(await media.reservedAmong([asset!.id])).toEqual([asset!.id]);
    expect((await media.list({ unused: true, limit: 50, offset: 0 })).rows).toHaveLength(0);
    expect((await media.list({ limit: 50, offset: 0 })).rows[0]!.reservedByJobId).toBe(a.job.id);
    await expect(
      createJob(project.id, { items: 1, itemOverrides: () => ({ mediaAssetId: asset!.id }) }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
    // Cancelling releases it.
    expect(await createJobItemsRepo(getDb(), project.id).cancelForJob(a.job.id, new Date())).toBe(1);
    expect(await media.reservedAmong([asset!.id])).toEqual([]);
    expect(await media.listIdsForSelection({ unusedOnly: true, limit: 10 })).toEqual([asset!.id]);
  });

  it("retries only failed items and checks the lease on update", async () => {
    const project = await createProject();
    const { items } = await createJob(project.id, { items: 2 });
    const repo = createJobItemsRepo(getDb(), project.id);
    expect(await repo.updateWithLease(items[0]!.id, crypto.randomUUID(), { status: "queued" })).toBeNull();
    // Nothing failed yet, so a retry changes nothing.
    expect(await repo.retryFailed(items[0]!.jobId, new Date())).toEqual([]);
  });

  it("builds CSV bytes with quoting", () => {
    expect(csvBuilder(["a", "b"], [["x,y", 'q"z']]).toString()).toBe('a,b\n"x,y","q""z"\n');
  });
});
