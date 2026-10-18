import { describe, expect, it } from "vitest";
import type { JsonTestResults } from "vitest/node";
import { buildReport, type ParsedLane, parseArgs, renderMarkdown } from "./flake-report";

const FILE = "tests/integration/example/thing.test.ts";

function results(assertions: { fullName: string; status: "passed" | "failed"; failureMessages?: string[] }[]): JsonTestResults {
  const numFailedTests = assertions.filter((a) => a.status === "failed").length;
  return {
    numFailedTests,
    numFailedTestSuites: numFailedTests > 0 ? 1 : 0,
    numPassedTests: assertions.filter((a) => a.status === "passed").length,
    numPassedTestSuites: 1,
    numPendingTests: 0,
    numPendingTestSuites: 0,
    numTodoTests: 0,
    numTotalTests: assertions.length,
    numTotalTestSuites: 1,
    startTime: 0,
    success: numFailedTests === 0,
    testResults: [
      {
        message: "",
        name: FILE,
        status: numFailedTests > 0 ? "failed" : "passed",
        startTime: 0,
        endTime: 1,
        assertionResults: assertions.map((a) => ({
          ancestorTitles: [],
          fullName: a.fullName,
          status: a.status,
          title: a.fullName,
          meta: {},
          failureMessages: a.failureMessages ?? (a.status === "failed" ? ["boom"] : null),
          tags: [],
          benchmarks: [],
        })),
      },
    ],
    snapshot: {
      added: 0,
      failure: false,
      filesAdded: 0,
      filesRemoved: 0,
      filesRemovedList: [],
      filesUnmatched: 0,
      filesUpdated: 0,
      matched: 0,
      total: 0,
      unchecked: 0,
      uncheckedKeysByFile: [],
      unmatched: 0,
      updated: 0,
      didUpdate: false,
    } as unknown as JsonTestResults["snapshot"],
  };
}

function lane(
  repetition: number,
  shard: number,
  data: JsonTestResults | null,
  opts: { meta?: { exitCode: number; seed: number; stderrTail: string } | null; unparseable?: string } = {},
): ParsedLane {
  const meta = opts.meta ?? { exitCode: 0, seed: repetition, stderrTail: "" };
  if (opts.unparseable) {
    return { repetition, shard, meta, result: { ok: false, reason: "unparseable", detail: opts.unparseable } };
  }
  if (data === null) {
    return { repetition, shard, meta, result: { ok: false, reason: "missing", detail: "no file" } };
  }
  return { repetition, shard, meta, result: { ok: true, data } };
}

describe("buildReport()", () => {
  it("marks a test failing some repetitions as non_deterministic", () => {
    const lanes = [
      lane(1, 1, results([{ fullName: "a flaky test", status: "passed" }])),
      lane(2, 1, results([{ fullName: "a flaky test", status: "failed", failureMessages: ["expected 1 to be 2"] }])),
      lane(3, 1, results([{ fullName: "a flaky test", status: "passed" }])),
    ];
    const report = buildReport(lanes);
    expect(report.tests).toHaveLength(1);
    expect(report.tests[0]).toMatchObject({ category: "non_deterministic", passed: 2, failed: 1 });
    expect(report.summary).toEqual({ total: 1, consistentlyPassing: 0, nonDeterministic: 1, consistentlyFailing: 0 });
  });

  it("marks a test failing every repetition as consistently_failing", () => {
    const lanes = [
      lane(1, 1, results([{ fullName: "a broken test", status: "failed" }])),
      lane(2, 1, results([{ fullName: "a broken test", status: "failed" }])),
    ];
    const report = buildReport(lanes);
    expect(report.tests[0]?.category).toBe("consistently_failing");
    expect(report.summary.consistentlyFailing).toBe(1);
  });

  it("marks a test passing every repetition as consistently_passing, omitted from the rendered markdown but counted in summary", () => {
    const lanes = [
      lane(1, 1, results([{ fullName: "a stable test", status: "passed" }])),
      lane(2, 1, results([{ fullName: "a stable test", status: "passed" }])),
    ];
    const report = buildReport(lanes);
    expect(report.tests[0]?.category).toBe("consistently_passing");
    expect(report.summary.consistentlyPassing).toBe(1);
    const markdown = renderMarkdown(report);
    expect(markdown).not.toContain("a stable test");
    expect(markdown).toContain("1 consistently passing");
  });

  it("attributes a missing lane output to no test, as a LaneFailure", () => {
    const lanes = [lane(1, 1, null)];
    const report = buildReport(lanes);
    expect(report.tests).toHaveLength(0);
    expect(report.laneFailures).toEqual([
      { repetition: 1, shard: 1, reason: "no_output", detail: "no test output file was produced" },
    ]);
  });

  it("attributes an unparseable lane output to no test, as a LaneFailure", () => {
    const lanes = [lane(1, 1, null, { unparseable: "Unexpected token" })];
    const report = buildReport(lanes);
    expect(report.tests).toHaveLength(0);
    expect(report.laneFailures).toEqual([{ repetition: 1, shard: 1, reason: "unparseable_output", detail: "Unexpected token" }]);
  });

  it("treats a non-zero exit with zero reported failures as a LaneFailure, not a test result", () => {
    const data = results([{ fullName: "a test that ran fine", status: "passed" }]);
    const lanes = [lane(1, 1, data, { meta: { exitCode: 1, seed: 1, stderrTail: "segfault" } })];
    const report = buildReport(lanes);
    expect(report.tests).toHaveLength(0);
    expect(report.laneFailures).toEqual([
      { repetition: 1, shard: 1, reason: "exited_without_failures", detail: "exit code 1 with 0 failed tests reported" },
    ]);
  });

  it("reports lane_died when a lane produced no output but a non-zero exit code was recorded", () => {
    const lanes = [lane(1, 1, null, { meta: { exitCode: 137, seed: 1, stderrTail: "OOMKilled" } })];
    const report = buildReport(lanes);
    expect(report.laneFailures).toEqual([{ repetition: 1, shard: 1, reason: "lane_died", detail: "exit code 137: OOMKilled" }]);
  });

  it("keeps both failure messages when a test fails with two distinct messages", () => {
    const lanes = [
      lane(1, 1, results([{ fullName: "a test", status: "failed", failureMessages: ["message one"] }])),
      lane(2, 1, results([{ fullName: "a test", status: "failed", failureMessages: ["message two"] }])),
      lane(3, 1, results([{ fullName: "a test", status: "passed" }])),
    ];
    const report = buildReport(lanes);
    expect(report.tests[0]?.failureMessages).toEqual(["message one", "message two"]);
  });

  it("infers --repetitions and --shards from the distinct values seen when not given", () => {
    const lanes = [
      lane(1, 1, results([{ fullName: "a test", status: "passed" }])),
      lane(1, 2, results([{ fullName: "a test", status: "passed" }])),
      lane(2, 1, results([{ fullName: "a test", status: "passed" }])),
      lane(2, 2, results([{ fullName: "a test", status: "passed" }])),
    ];
    const report = buildReport(lanes);
    expect(report.repetitions).toBe(2);
    expect(report.shards).toBe(2);
  });

  it("uses explicit --repetitions/--shards overrides over the inferred values", () => {
    const lanes = [lane(1, 1, results([{ fullName: "a test", status: "passed" }]))];
    const report = buildReport(lanes, { repetitions: 20, shards: 4 });
    expect(report.repetitions).toBe(20);
    expect(report.shards).toBe(4);
  });
});

describe("parseArgs()", () => {
  it("requires --input", () => {
    expect(parseArgs([])).toBeNull();
  });

  it("accepts --input with defaults for the rest", () => {
    expect(parseArgs(["--input", ".flake/in"])).toEqual({ input: ".flake/in", out: "." });
  });

  it("accepts --input, --out, --repetitions and --shards together", () => {
    expect(parseArgs(["--input", "in", "--out", "out", "--repetitions", "20", "--shards", "4"])).toEqual({
      input: "in",
      out: "out",
      repetitions: 20,
      shards: 4,
    });
  });

  it("refuses a non-numeric --repetitions", () => {
    expect(parseArgs(["--input", "in", "--repetitions", "nope"])).toBeNull();
  });

  it("refuses an unknown flag", () => {
    expect(parseArgs(["--input", "in", "--bogus", "x"])).toBeNull();
  });
});
