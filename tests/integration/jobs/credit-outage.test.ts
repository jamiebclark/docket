import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../../src/server/db/client";
import { runCrossProject } from "../../../src/server/db/cross-project";
import { generationJobItems, posts } from "../../../src/server/db/schema";
import { llmFailureMessage } from "../../../src/server/llm/messages";
import { setLlmForTests } from "../../../src/server/llm";
import type { LlmProvider, LlmRequest, LlmResult } from "../../../src/server/llm/types";
import { runTick } from "../../../src/server/scheduler";
import { JOB_ITEM_MAX_ATTEMPTS } from "../../../src/server/scheduler/config";
import { createJob } from "../../../src/server/services/jobs";
import { setStorageForTests } from "../../../src/server/storage";
import { atTime } from "../../helpers/clock";
import { closeDb } from "../../helpers/db";
import { jobsEnv, tickConfig } from "../../helpers/jobs-env";

afterAll(async () => {
  setLlmForTests(null);
  setStorageForTests(undefined);
  await closeDb();
});

const tickAt = (at: Date, over: Record<string, unknown> = {}) =>
  atTime(at, () => runTick(tickConfig({ jobMaxItems: 10, ...over })));

/** Refuses on billing until `succeed()` is called; records every request's label for counting. */
function switchableLlm(): LlmProvider & { requests: string[]; succeed(): void } {
  let ok = false;
  const requests: string[] = [];
  const base = { usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1, provider: "openai" as const, model: "fake-model" };
  return {
    name: "openai",
    model: "fake-model",
    requests,
    succeed() {
      ok = true;
    },
    async generate<T>(request: LlmRequest<T>): Promise<LlmResult<T>> {
      requests.push(request.label);
      if (!ok) {
        return { ok: false, kind: "credit_exhausted", message: llmFailureMessage("credit_exhausted"), rawText: null, ...base };
      }
      const parsed = request.schema.safeParse(
        JSON.parse('{"variants":{"mock":{"text":"Recovered"}},"imageAltTexts":["Alt text 1"]}'),
      );
      return parsed.success
        ? { ok: true, value: parsed.data as T, rawText: "ok", ...base }
        : { ok: false, kind: "invalid_output", message: llmFailureMessage("invalid_output"), rawText: "bad", ...base };
    },
  };
}

describe("credit outage (US1 AS4, SC-001)", () => {
  it("AS4: 120 minutes of continuous refusal, then recovery with one post per item", async () => {
    // A single item keeps the request budget exact: one detecting call, then one probe per 5-minute
    // interval (SC-002: ≤ 12/hour ⇒ ≤ 24 across the two simulated hours).
    const e = await jobsEnv();
    const fake = switchableLlm();
    setLlmForTests(fake);
    await e.asset();
    const { jobId } = await createJob(e.scope, e.input());

    let t = new Date();
    for (let minute = 0; minute < 120; minute++) {
      await tickAt(t);
      t = new Date(t.getTime() + 60_000);
    }
    expect(fake.requests.length).toBeLessThanOrEqual(24);
    const afterOutage = await e.scope.jobItems.listForJob(jobId);
    expect(afterOutage.every((i) => i.status !== "failed")).toBe(true);
    expect(afterOutage.every((i) => i.attemptCount < JOB_ITEM_MAX_ATTEMPTS)).toBe(true);

    fake.succeed();
    // One probe tick clears the hold; a following tick claims the rest at full budget.
    await tickAt(t);
    t = new Date(t.getTime() + 60_000);
    await tickAt(t);

    const afterRecovery = await e.scope.jobItems.listForJob(jobId);
    expect(afterRecovery.every((i) => i.status === "done")).toBe(true);
    const rows = await runCrossProject("test: posts after recovery", () =>
      getDb().select().from(posts).where(eq(posts.projectId, e.project.id)),
    );
    for (const item of afterRecovery) {
      expect(rows.filter((r) => r.generationJobItemId === item.id)).toHaveLength(1);
    }
  // 122 real ticks against a real database. ~13s run alone, but it shares a four-core CI runner with
  // two other vitest workers on one Postgres, where it has been seen to pass 120s and time out. The
  // budget here is wall-clock headroom for contention, not an expectation about how long this takes.
  }, 420_000);

  it("SC-001: a 500-item job seeded directly survives a simulated two-hour outage with zero failed", async () => {
    const e = await jobsEnv();
    const fake = switchableLlm();
    setLlmForTests(fake);
    await e.asset();
    const { jobId } = await createJob(e.scope, e.input());
    const now = new Date();
    await runCrossProject("test: seed 500 items", async () => {
      const existing = await getDb()
        .select({ projectId: generationJobItems.projectId })
        .from(generationJobItems)
        .where(eq(generationJobItems.jobId, jobId))
        .limit(1);
      const projectId = existing[0]!.projectId;
      const rows = Array.from({ length: 499 }, (_, i) => ({
        projectId,
        jobId,
        position: i + 2,
        label: `item-${i + 2}`,
        status: "queued" as const,
        nextAttemptAt: now,
        payload: {},
        attemptCount: 0,
      }));
      await getDb().insert(generationJobItems).values(rows);
    });
    await e.scope.jobs.update(jobId, { itemCount: 500 });

    let t = now;
    for (let minute = 0; minute < 120; minute += 30) {
      await tickAt(t, { jobMaxItems: 50 });
      t = new Date(t.getTime() + 30 * 60_000);
    }
    const items = await e.scope.jobItems.listForJob(jobId, { limit: 500 });
    expect(items.every((i) => i.status !== "failed")).toBe(true);
    expect(items.every((i) => i.attemptCount === 0)).toBe(true);
    const job = await e.scope.jobs.get(jobId);
    expect(job!.status).not.toBe("completed_with_failures");
  // 122 real ticks against a real database. ~13s run alone, but it shares a four-core CI runner with
  // two other vitest workers on one Postgres, where it has been seen to pass 120s and time out. The
  // budget here is wall-clock headroom for contention, not an expectation about how long this takes.
  }, 420_000);
});
