import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { setLlmForTests } from "../../../src/server/llm";
import { runTick } from "../../../src/server/scheduler";
import * as accounts from "../../../src/server/services/accounts";
import { createJob } from "../../../src/server/services/jobs";
import { setStorageForTests } from "../../../src/server/storage";
import { closeDb } from "../../helpers/db";
import { createFakeLlm } from "../../helpers/fake-llm";
import { jobsEnv, modelOk, parkAllJobs } from "../../helpers/jobs-env";

beforeEach(parkAllJobs);
afterAll(async () => {
  setLlmForTests(null);
  setStorageForTests(undefined);
  await closeDb();
});

type Env = Awaited<ReturnType<typeof jobsEnv>>;

async function drain(e: Env, jobId: string) {
  for (let i = 0; i < 15; i++) {
    await runTick({ config: { jobMaxItems: 1 } });
    const counts = await e.scope.jobItems.countByStatus(jobId);
    if (counts.queued + counts.running === 0) break;
  }
}

async function outcomes(e: Env, jobId: string) {
  const items = await e.scope.jobItems.listForJob(jobId);
  const out = [];
  for (const item of items) {
    const post = (await e.scope.posts.findByJobItemId(item.id))!;
    out.push({ item, post, targets: await e.scope.targets.listForPost(post.id) });
  }
  return out;
}

const APPROVALS = ["review_required", "auto_approve"] as const;
const SCHEDULINGS = ["leave_as_draft", "add_to_queue"] as const;

describe("the policy matrix in a job (SC-005)", () => {
  for (const approval of APPROVALS) {
    for (const scheduling of SCHEDULINGS) {
      it(`${approval} + ${scheduling}: valid items follow the policy, an Instagram text-only item always lands in review`, async () => {
        const e = await jobsEnv();
        const ig = await accounts.saveConnectedAccount(e.scope, {
          providerKey: "instagram",
          externalAccountId: `ig-${randomUUID().slice(0, 8)}`,
          displayName: "Insta",
          settings: {},
        });
        setLlmForTests(createFakeLlm([]));
        // CSV items have no image, so Instagram cannot publish them.
        const csv = "name\nMug\nHat\n";
        const igJob = await createJob(
          e.scope,
          e.input({ source: { kind: "csv" }, template: "About {{name}}.", targetAccountIds: [ig.id], approval, scheduling, confirmUnreviewedQueue: true }),
          { file: { name: "items.csv", bytes: Buffer.from(csv) } },
        );
        setLlmForTests(createFakeLlm(Array.from({ length: 8 }, () => ({ ok: { variants: { instagram: { text: "Fine." } } } }))));
        await drain(e, igJob.jobId);
        setLlmForTests(createFakeLlm(Array.from({ length: 8 }, () => modelOk("Fine."))));
        const mockJob = await createJob(
          e.scope,
          e.input({ source: { kind: "csv" }, template: "About {{name}}.", approval, scheduling, confirmUnreviewedQueue: true }),
          { file: { name: "items.csv", bytes: Buffer.from(csv) } },
        );
        await drain(e, mockJob.jobId);

        for (const { item, post, targets } of await outcomes(e, igJob.jobId)) {
          expect(item.status).toBe("done");
          expect(post.reviewState).toBe("needs_review");
          expect(targets.some((t) => t.status === "scheduled")).toBe(false);
        }
        const rows = await outcomes(e, mockJob.jobId);
        expect(rows).toHaveLength(2);
        for (const { item, post, targets } of rows) {
          expect(item.status).toBe("done");
          expect(post.reviewState).toBe(approval === "auto_approve" ? "approved" : "needs_review");
          const queued = approval === "auto_approve" && scheduling === "add_to_queue";
          expect(targets.every((t) => (queued ? t.status === "scheduled" : t.status === "draft"))).toBe(true);
        }
      }, 120_000);
    }
  }

  it("approves but leaves the target unscheduled when the account has no slots; the item is still done", async () => {
    const e = await jobsEnv();
    const bare = await e.addAccount({}, false);
    setLlmForTests(createFakeLlm([modelOk("One", 1), modelOk("Two", 1)]));
    await e.assets(2);
    const { jobId } = await createJob(
      e.scope,
      e.input({ targetAccountIds: [bare.id], approval: "auto_approve", scheduling: "add_to_queue", confirmUnreviewedQueue: true }),
    );
    await drain(e, jobId);
    const rows = await outcomes(e, jobId);
    expect(rows).toHaveLength(2);
    for (const { item, post, targets } of rows) {
      expect(item.status).toBe("done");
      expect(post.reviewState).toBe("approved");
      expect(targets.every((t) => t.status === "draft" && t.scheduledAt === null)).toBe(true);
    }
  }, 120_000);

  it("takes slots in item order", async () => {
    const e = await jobsEnv();
    setLlmForTests(createFakeLlm([modelOk("A", 1), modelOk("B", 1), modelOk("C", 1)]));
    await e.assets(3);
    const { jobId } = await createJob(
      e.scope,
      e.input({ approval: "auto_approve", scheduling: "add_to_queue", confirmUnreviewedQueue: true }),
    );
    await drain(e, jobId);
    const rows = (await outcomes(e, jobId)).sort((a, b) => a.item.position - b.item.position);
    const times = rows.map((r) => r.targets[0]!.scheduledAt!.getTime());
    expect(times.every((t) => Number.isFinite(t))).toBe(true);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(new Set(times).size).toBe(3);
  }, 120_000);
});
