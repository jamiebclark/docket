import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { markWorkerProcess, unmarkWorkerProcessForTests } from "../../../src/server/video/guard";
import { runTool, ToolMissingError } from "../../../src/server/video/spawn";

// `node` stands in for ffmpeg: spawn.ts is binary-agnostic, so these run without ffmpeg installed.
const node = process.execPath;
const sleeper = ["-e", "setTimeout(() => {}, 60000)"];

describe("runTool", () => {
  beforeEach(() => markWorkerProcess());
  afterEach(() => markWorkerProcess());

  it("throws unless the process was marked as the worker", async () => {
    unmarkWorkerProcessForTests();
    expect(() => runTool(node, ["-e", "0"], { timeoutMs: 1000 })).toThrow(/worker/);
  });

  it("returns code, stdout and a bounded stderr tail", async () => {
    const r = await runTool(node, ["-e", "console.log('out'); console.error('x'.repeat(50000))"], {
      timeoutMs: 10_000,
      stderrTail: 100,
    });
    expect(r).toMatchObject({ code: 0, killed: false });
    expect(r.stdout.trim()).toBe("out");
    expect(r.stderrTail.length).toBeLessThanOrEqual(100);
  });

  it("truncates stdout at the cap", async () => {
    const r = await runTool(node, ["-e", "process.stdout.write('y'.repeat(100000))"], { timeoutMs: 10_000, maxStdout: 1000 });
    expect(r.stdout.length).toBe(1000);
  });

  it("kills on timeout", async () => {
    const r = await runTool(node, sleeper, { timeoutMs: 200 });
    expect(r.killed).toBe(true);
    expect(r.signal).toBe("SIGTERM");
  });

  it("kills on abort, including an already-aborted signal", async () => {
    const c = new AbortController();
    const pending = runTool(node, sleeper, { timeoutMs: 30_000, signal: c.signal });
    setTimeout(() => c.abort(), 100);
    expect((await pending).killed).toBe(true);
    expect((await runTool(node, sleeper, { timeoutMs: 30_000, signal: AbortSignal.abort() })).killed).toBe(true);
  });

  it("reports a missing binary clearly", async () => {
    await expect(runTool("docket-no-such-binary", [], { timeoutMs: 1000 })).rejects.toBeInstanceOf(ToolMissingError);
  });
});
