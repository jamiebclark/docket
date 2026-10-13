import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeLlm } from "../../../tests/helpers/fake-llm";
import { runAtTime } from "../dal/clock";
import type { LlmUsageInsert, LlmUsageRepo } from "../dal/llm-usage";
import { createUsageRecorder } from "./usage";

function stubRepo(): LlmUsageRepo & { rows: LlmUsageInsert[]; calls: number } {
  const rows: LlmUsageInsert[] = [];
  let calls = 0;
  return {
    get rows() {
      return rows;
    },
    get calls() {
      return calls;
    },
    async record(batch) {
      calls += 1;
      rows.push(...batch);
    },
    async summary() {
      throw new Error("not used in this test");
    },
    async byModel() {
      throw new Error("not used in this test");
    },
    async byPurpose() {
      throw new Error("not used in this test");
    },
    async totalsForJob() {
      throw new Error("not used in this test");
    },
  };
}

const schema = z.object({ text: z.string() });

function request(label = "generate.single") {
  return { label, system: "the system prompt, never logged", user: "the user prompt, never logged", images: [], schemaName: "out", schema };
}

const AT = new Date("2026-01-01T00:00:00Z");

describe("createUsageRecorder", () => {
  it("wrap never alters, delays beyond its own buffering, or replaces generate's return value", async () => {
    const unwrapped = createFakeLlm([{ ok: { text: "hi" } }], { provider: "openai", model: "fake-model" });
    const expected = await unwrapped.generate(request());

    const llm = createFakeLlm([{ ok: { text: "hi" } }], { provider: "openai", model: "fake-model" });
    const recorder = createUsageRecorder({ projectId: "p1", purpose: "generate.single", source: "install", repo: stubRepo() });
    const wrapped = recorder.wrap(llm);
    const actual = await runAtTime(AT, () => wrapped.generate(request()));

    expect(actual).toEqual(expected);
  });

  it("flush is a no-op on an empty buffer", async () => {
    const repo = stubRepo();
    const recorder = createUsageRecorder({ projectId: "p1", purpose: "generate.single", source: "install", repo });
    await recorder.flush({});
    expect(repo.calls).toBe(0);
    expect(repo.rows).toEqual([]);
  });

  it("a second flush writes nothing twice", async () => {
    const repo = stubRepo();
    const llm = createFakeLlm([{ ok: { text: "hi" } }]);
    const recorder = createUsageRecorder({ projectId: "p1", purpose: "generate.single", source: "install", repo });
    const wrapped = recorder.wrap(llm);
    await runAtTime(AT, () => wrapped.generate(request()));

    await recorder.flush({ postId: "post-1" });
    expect(repo.rows).toHaveLength(1);

    await recorder.flush({ postId: "post-1" });
    expect(repo.rows).toHaveLength(1);
    expect(repo.calls).toBe(1);
  });

  it("only calls this recorder observed are written", async () => {
    const repo = stubRepo();
    const llmA = createFakeLlm([{ ok: { text: "a" } }]);
    const llmB = createFakeLlm([{ ok: { text: "b" } }]);
    const recorderA = createUsageRecorder({ projectId: "p1", purpose: "generate.single", source: "install", repo });
    const recorderB = createUsageRecorder({ projectId: "p1", purpose: "generate.regenerate", source: "project", repo });

    await runAtTime(AT, () => recorderA.wrap(llmA).generate(request("generate.single")));
    await recorderA.flush({ postId: "post-a" });

    expect(repo.rows).toHaveLength(1);
    expect(repo.rows[0]).toMatchObject({ purpose: "generate.single", postId: "post-a" });

    await runAtTime(AT, () => recorderB.wrap(llmB).generate(request("generate.regenerate")));
    await recorderB.flush({ postId: "post-b" });

    expect(repo.rows).toHaveLength(2);
    expect(repo.rows[1]).toMatchObject({ purpose: "generate.regenerate", postId: "post-b" });
  });

  it("a forced repo failure is swallowed and logged with no prompt, output or credential in the line", async () => {
    const repo = stubRepo();
    repo.record = async () => {
      throw new Error("connection error: password=sk-SECRETVALUE");
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const llm = createFakeLlm([{ ok: { text: "the raw output, never logged" } }]);
      const recorder = createUsageRecorder({ projectId: "p1", purpose: "generate.single", source: "install", repo });
      const wrapped = recorder.wrap(llm);
      await expect(runAtTime(AT, () => wrapped.generate(request()))).resolves.toMatchObject({ ok: true });
      await expect(recorder.flush({})).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const line = JSON.stringify(errorSpy.mock.calls[0]);
      expect(line).not.toContain("never logged");
      expect(line).not.toContain("the system prompt");
      expect(line).not.toContain("the user prompt");
      expect(line).not.toContain("sk-SECRETVALUE");
      expect(line).not.toContain("connection error");
    } finally {
      errorSpy.mockRestore();
    }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  // No-op: each test seeds its own fake clock via runAtTime.
});
