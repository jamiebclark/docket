import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../../../src/server/db/client";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { generationJobs } from "../../../src/server/db/schema";
import { ValidationIssuesError } from "../../../src/server/dal/errors";
import { setLlmForTests } from "../../../src/server/llm";
import { runTick } from "../../../src/server/scheduler";
import * as accounts from "../../../src/server/services/accounts";
import { appendItems, createJob, getJob } from "../../../src/server/services/jobs";
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

const OLD = "Old rule: keep it formal.";
const NEW = "New rule: be playful.";

async function setup(n = 1, images = 0) {
  const fake = createFakeLlm(Array.from({ length: n }, () => modelOk("A post.", images)));
  const env = await jobsEnv();
  setLlmForTests(fake);
  await accounts.setPostingInstructions(env.scope, env.account.id, { instructions: OLD });
  return { ...env, fake };
}
type Env = Awaited<ReturnType<typeof setup>>;

async function drain(e: Env, jobId: string) {
  for (let i = 0; i < 10; i++) {
    await runTick({ config: { jobMaxItems: 5 } });
    const c = await e.scope.jobItems.countByStatus(jobId);
    if (c.queued + c.running === 0) break;
  }
}

const snapshotOf = async (jobId: string) =>
  (await e0().scope.jobs.get(jobId))!.postingInstructionsSnapshot as { v: number; byAccount: Record<string, string | null> } | null;
let current: Env;
const e0 = () => current;

async function recordsOf(e: Env, jobId: string) {
  const out = [];
  for (const item of await e.scope.jobItems.listForJob(jobId)) {
    const post = await e.scope.posts.findByJobItemId(item.id);
    if (post) out.push((post.generationMetadata as { records: { accounts?: { instructions: string | null }[] }[] }).records[0]!);
  }
  return out;
}

describe("jobs keep the posting instructions they were created with (US5)", () => {
  it("stores a snapshot for media, CSV and API jobs", async () => {
    const e = (current = await setup());
    await e.asset();
    const media = await createJob(e.scope, e.input());
    const csv = await createJob(e.scope, e.input({ source: { kind: "csv" }, template: "About {{name}}." }), {
      file: { name: "i.csv", bytes: Buffer.from("name\nMug\n") },
    });
    const api = await createJob(e.scope, e.input({ source: { kind: "api", fields: ["x"], open: true }, template: "Say {{x}}." }));
    for (const id of [media.jobId, csv.jobId, api.jobId]) {
      expect(await snapshotOf(id)).toEqual({ v: 1, byAccount: { [e.account.id]: OLD } });
    }
  }, 60_000);

  it("runs items — including API-appended ones — with the snapshot after the account changes; a second job uses the new text", async () => {
    const e = (current = await setup(3));
    const { jobId } = await createJob(
      e.scope,
      e.input({ source: { kind: "api", fields: ["x"], open: true }, template: "Say {{x}}." }),
    );
    await accounts.setPostingInstructions(e.scope, e.account.id, { instructions: NEW });
    await appendItems(e.scope, jobId, { items: [{ fields: { x: "one" } }] });
    await drain(e, jobId);
    expect(e.fake.requests[0]!.system).toContain(OLD);
    expect(e.fake.requests[0]!.system).not.toContain(NEW);
    expect((await recordsOf(e, jobId))[0]!.accounts![0]!.instructions).toBe(OLD);

    const second = await createJob(e.scope, e.input({ source: { kind: "api", fields: ["x"], open: true }, template: "Say {{x}}." }));
    await appendItems(e.scope, second.jobId, { items: [{ fields: { x: "two" } }] });
    await drain(e, second.jobId);
    expect(e.fake.requests.at(-1)!.system).toContain(NEW);
    expect((await recordsOf(e, second.jobId))[0]!.accounts![0]!.instructions).toBe(NEW);
  }, 60_000);

  it("drops a removed account while the others keep their snapshot", async () => {
    const e = (current = await setup(1, 1));
    const other = await e.addAccount();
    await accounts.setPostingInstructions(e.scope, other.id, { instructions: "Other rule." });
    await e.asset();
    const { jobId } = await createJob(e.scope, e.input({ targetAccountIds: [e.account.id, other.id] }));
    await accounts.removeAccount(e.scope, other.id);
    await accounts.setPostingInstructions(e.scope, e.account.id, { instructions: NEW });
    const view = await getJob(e.scope, jobId);
    expect(view.targets.map((t) => [t.removed, t.instructions])).toEqual([
      [false, OLD],
      [true, "Other rule."],
    ]);
    await drain(e, jobId);
    const [record] = await recordsOf(e, jobId);
    expect(record!.accounts!.map((a) => a.instructions)).toEqual([OLD]);
  }, 60_000);

  it("a pre-feature job (NULL snapshot) uses current instructions and reports 'not_recorded'", async () => {
    const e = (current = await setup(1, 1));
    await e.asset();
    const { jobId } = await createJob(e.scope, e.input());
    await runCrossProject("test: null snapshot", async () => {
      await getDb().update(generationJobs).set({ postingInstructionsSnapshot: null }).where(eq(generationJobs.id, jobId));
    });
    await accounts.setPostingInstructions(e.scope, e.account.id, { instructions: NEW });
    expect((await getJob(e.scope, jobId)).targets[0]!.instructions).toBe("not_recorded");
    await drain(e, jobId);
    expect(e.fake.requests[0]!.system).toContain(NEW);
    expect((await recordsOf(e, jobId))[0]!.accounts![0]!.instructions).toBe(NEW);
  }, 60_000);

  it("refuses more than 16 groups at creation", async () => {
    const e = (current = await setup());
    const ids = [e.account.id];
    for (let i = 0; i < 16; i++) {
      const a = await e.addAccount();
      await accounts.setPostingInstructions(e.scope, a.id, { instructions: `Rules ${i}` });
      ids.push(a.id);
    }
    await expect(createJob(e.scope, e.input({ targetAccountIds: ids }))).rejects.toBeInstanceOf(ValidationIssuesError);
  }, 60_000);
});
