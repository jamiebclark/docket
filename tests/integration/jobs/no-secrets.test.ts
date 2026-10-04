// FR-035 / constitution VII, extended to jobs: a configured API key never reaches job rows, item rows, posts, logs or results.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setLlmForTests } from "../../../src/server/llm";
import { runTick } from "../../../src/server/scheduler";
import { cancelJob, createJob, getJob, listJobs } from "../../../src/server/services/jobs";
import { setStorageForTests } from "../../../src/server/storage";
import { closeDb } from "../../helpers/db";
import { createFakeLlm } from "../../helpers/fake-llm";
import { jobsEnv, modelOk, parkAllJobs } from "../../helpers/jobs-env";

const SECRET = "sk-DISTINCTIVE-fake-secret-7f3a91c2e8b4";
const saved: Record<string, string | undefined> = {};
const lines: string[] = [];

beforeAll(() => {
  for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) {
    saved[name] = process.env[name];
    process.env[name] = SECRET;
  }
});
beforeEach(parkAllJobs);
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  setLlmForTests(null);
  setStorageForTests(undefined);
  await closeDb();
});

describe("no secrets in jobs", () => {
  it("never appears in item rows, posts, prompt records, logs or service results", async () => {
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      });
    }
    const e = await jobsEnv();
    const fake = createFakeLlm([modelOk("Good", 1), { fail: "unavailable" }, { fail: "invalid_output" }, { fail: "invalid_output" }]);
    setLlmForTests(fake);
    await e.assets(3);
    const { jobId } = await createJob(e.scope, e.input({ template: `Write about this photo. Key ${SECRET}` }));
    for (let i = 0; i < 4; i++) await runTick({ config: { jobMaxItems: 3 } });

    const results: unknown[] = [await getJob(e.scope, jobId), await listJobs(e.scope, {}), await e.scope.jobs.get(jobId)];
    const items = await e.scope.jobItems.listForJob(jobId);
    results.push(items);
    for (const item of items) {
      const post = await e.scope.posts.findByJobItemId(item.id);
      if (post) results.push(post);
    }
    results.push(await cancelJob(e.scope, jobId));

    // The template is the user's own text, so the check is on everything the runner derives from the key itself.
    const stored = JSON.stringify(results.map((r) => JSON.parse(JSON.stringify(r))));
    const withoutTemplate = stored.split(`Key ${SECRET}`).join("Key <template>");
    expect(withoutTemplate).not.toContain(SECRET);
    expect(lines.join("\n")).not.toContain(SECRET);
    expect(lines.some((l) => l.includes("generation_job_item"))).toBe(true);
  }, 120_000);
});
