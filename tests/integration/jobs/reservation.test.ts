import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { setLlmForTests } from "../../../src/server/llm";
import { cancelJob, createJob } from "../../../src/server/services/jobs";
import { setStorageForTests } from "../../../src/server/storage";
import { closeDb } from "../../helpers/db";
import { createFakeLlm } from "../../helpers/fake-llm";
import { jobsEnv, parkAllJobs } from "../../helpers/jobs-env";

beforeEach(parkAllJobs);
afterAll(async () => {
  setLlmForTests(null);
  setStorageForTests(undefined);
  await closeDb();
});

async function setup() {
  const env = await jobsEnv();
  setLlmForTests(createFakeLlm([]));
  return env;
}

const settle = (p: Promise<unknown>) => p.then((value) => ({ value, error: null as Error | null }), (error: Error) => ({ value: null, error }));

describe("reservation (US3)", () => {
  it("never puts an image in two jobs, across 25 concurrent races", async () => {
    for (let run = 0; run < 25; run++) {
      const e = await setup();
      const imgs = await e.assets(4);
      const results = await Promise.all([settle(createJob(e.scope, e.input())), settle(createJob(e.scope, e.input()))]);
      const ids: string[] = [];
      for (const r of results) {
        if (r.value) ids.push(...(await e.scope.jobItems.listForJob((r.value as { jobId: string }).jobId)).map((i) => i.mediaAssetId!));
        else expect(r.error!.message).toContain("No unused images left to generate for");
      }
      expect(ids.sort()).toEqual(imgs.map((i) => i.id).sort());
    }
  });

  it("hides reserved images from `unused`, flags them, and skips them on pick", async () => {
    const e = await setup();
    const [a, b] = await e.assets(2);
    const { jobId } = await createJob(e.scope, e.input({ source: { kind: "media", selection: { mode: "pick", ids: [a!.id] }, includeUsed: false } }));
    const unused = await e.scope.media.list({ unused: true } as never);
    expect(unused.rows.map((r) => r.id)).toEqual([b!.id]);
    const reservedRow = await e.scope.media.list({} as never);
    expect(reservedRow.rows.find((r) => r.id === a!.id)!.reservedByJobId).toBe(jobId);
    const picked = await createJob(e.scope, e.input({ source: { kind: "media", selection: { mode: "pick", ids: [a!.id, b!.id] }, includeUsed: false } }));
    expect(picked).toMatchObject({ itemCount: 1, skippedReserved: 1 });
    expect((await e.scope.media.reservedAmong([a!.id, b!.id])).sort()).toEqual([a!.id, b!.id].sort());
  });

  it("cancel releases images so a third job picks them up", async () => {
    const e = await setup();
    const imgs = await e.assets(3);
    const first = await createJob(e.scope, e.input());
    expect(await e.scope.media.reservedAmong(imgs.map((i) => i.id))).toHaveLength(3);
    const res = await cancelJob(e.scope, first.jobId);
    expect(res).toMatchObject({ changed: true, count: 3 });
    expect((await e.scope.jobs.get(first.jobId))!.status).toBe("cancelled");
    expect(await e.scope.media.reservedAmong(imgs.map((i) => i.id))).toHaveLength(0);
    expect(await cancelJob(e.scope, first.jobId)).toMatchObject({ changed: false });
    const third = await createJob(e.scope, e.input());
    expect(third.itemCount).toBe(3);
  });
});
