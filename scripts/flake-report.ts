// Consolidates N repeated, sharded runs of the suite into one report naming every
// non-deterministic test (FR-002 to FR-005, data-model.md section 3, contracts/flake-report.md).
// The core (buildReport/renderMarkdown) is pure — fed parsed lane data, not files — so it is
// unit-testable with in-memory fixtures; readLanes() is the only part that touches disk.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { JsonTestResults } from "vitest/node";
import { testWorkerCount } from "../tests/setup/worker-databases";

export interface TestVerdict {
  file: string;
  fullName: string;
  passed: number;
  failed: number;
  skipped: number;
  failureMessages: string[];
  failedOn: { repetition: number; shard: number; seed: number }[];
  category: "consistently_passing" | "non_deterministic" | "consistently_failing";
}

export interface LaneFailure {
  repetition: number;
  shard: number;
  reason: "no_output" | "unparseable_output" | "exited_without_failures" | "lane_died";
  detail: string;
}

export interface FlakeReport {
  generatedAt: string;
  repetitions: number;
  shards: number;
  profile: { command: string; maxWorkers: number; shuffleFiles: true; seeds: number[] };
  tests: TestVerdict[];
  laneFailures: LaneFailure[];
  summary: { total: number; consistentlyPassing: number; nonDeterministic: number; consistentlyFailing: number };
}

interface LaneMeta {
  exitCode: number;
  seed: number;
  stderrTail: string;
}

/** One lane's result, already parsed (or explained as unusable). The unit the whole module is built from. */
export interface ParsedLane {
  repetition: number;
  shard: number;
  result: { ok: true; data: JsonTestResults } | { ok: false; reason: "missing" | "unparseable"; detail: string };
  meta: LaneMeta | null;
}

function classifyLane(lane: ParsedLane): LaneFailure | null {
  const { repetition, shard, result, meta } = lane;
  if (result.ok) {
    if (result.data.numFailedTests === 0 && meta && meta.exitCode !== 0) {
      return {
        repetition,
        shard,
        reason: "exited_without_failures",
        detail: `exit code ${meta.exitCode} with 0 failed tests reported`,
      };
    }
    return null;
  }
  if (result.reason === "unparseable") {
    return { repetition, shard, reason: "unparseable_output", detail: result.detail };
  }
  if (meta && meta.exitCode !== 0) {
    return {
      repetition,
      shard,
      reason: "lane_died",
      detail: meta.stderrTail ? `exit code ${meta.exitCode}: ${meta.stderrTail}` : `exit code ${meta.exitCode}`,
    };
  }
  return {
    repetition,
    shard,
    reason: "no_output",
    detail: meta ? "no test output file was produced" : "no test output or metadata was produced",
  };
}

/** Builds the report from already-parsed lanes. Pure: no disk access, deterministic given its input. */
export function buildReport(
  lanes: readonly ParsedLane[],
  overrides: { repetitions?: number; shards?: number; profile?: { command: string; maxWorkers: number } } = {},
): FlakeReport {
  const laneFailures: LaneFailure[] = [];
  const verdicts = new Map<string, TestVerdict>();
  const seeds = new Set<number>();
  const repetitionsSeen = new Set<number>();
  const shardsSeen = new Set<number>();

  for (const lane of lanes) {
    repetitionsSeen.add(lane.repetition);
    shardsSeen.add(lane.shard);
    seeds.add(lane.meta?.seed ?? lane.repetition);

    const failure = classifyLane(lane);
    if (failure) {
      laneFailures.push(failure);
      continue;
    }
    if (!lane.result.ok) continue;

    for (const fileResult of lane.result.data.testResults) {
      for (const assertion of fileResult.assertionResults) {
        const key = `${fileResult.name}\u0000${assertion.fullName}`;
        let verdict = verdicts.get(key);
        if (!verdict) {
          verdict = {
            file: fileResult.name,
            fullName: assertion.fullName,
            passed: 0,
            failed: 0,
            skipped: 0,
            failureMessages: [],
            failedOn: [],
            category: "consistently_passing",
          };
          verdicts.set(key, verdict);
        }
        if (assertion.status === "passed") {
          verdict.passed++;
        } else if (assertion.status === "failed") {
          verdict.failed++;
          verdict.failedOn.push({ repetition: lane.repetition, shard: lane.shard, seed: lane.meta?.seed ?? lane.repetition });
          for (const message of assertion.failureMessages ?? []) {
            if (!verdict.failureMessages.includes(message)) verdict.failureMessages.push(message);
          }
        } else {
          verdict.skipped++;
        }
      }
    }
  }

  for (const verdict of verdicts.values()) {
    verdict.category =
      verdict.failed > 0 && verdict.passed > 0
        ? "non_deterministic"
        : verdict.failed > 0
          ? "consistently_failing"
          : "consistently_passing";
  }

  const all = [...verdicts.values()];
  const nonDeterministic = all.filter((v) => v.category === "non_deterministic");
  const consistentlyFailing = all.filter((v) => v.category === "consistently_failing");
  const consistentlyPassing = all.filter((v) => v.category === "consistently_passing");

  const shards = overrides.shards ?? shardsSeen.size;
  const profile = overrides.profile ?? { command: `vitest run --shard=<s>/${shards}`, maxWorkers: 0 };

  return {
    generatedAt: new Date().toISOString(),
    repetitions: overrides.repetitions ?? repetitionsSeen.size,
    shards,
    profile: { ...profile, shuffleFiles: true, seeds: [...seeds].sort((a, b) => a - b) },
    tests: [...nonDeterministic, ...consistentlyFailing, ...consistentlyPassing],
    laneFailures,
    summary: {
      total: all.length,
      consistentlyPassing: consistentlyPassing.length,
      nonDeterministic: nonDeterministic.length,
      consistentlyFailing: consistentlyFailing.length,
    },
  };
}

function indentBlock(text: string): string {
  return text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

function renderFailureMessages(messages: readonly string[]): string {
  const label = `${messages.length} distinct failure${messages.length === 1 ? "" : "s"}`;
  const body = messages.map(indentBlock).join("\n\n");
  return `<details><summary>${label}</summary>\n\n${body}\n</details>`;
}

function renderFailedOn(failedOn: TestVerdict["failedOn"]): string {
  return `Failed on ${failedOn.map((f) => `rep ${f.repetition} shard ${f.shard} (seed ${f.seed})`).join(", ")}.`;
}

function renderSection(title: string, tests: readonly TestVerdict[]): string {
  const lines = [`## ${title} (${tests.length})`, ""];
  if (tests.length === 0) {
    lines.push("_None._");
    return lines.join("\n");
  }
  let lastFile: string | null = null;
  for (const test of tests) {
    if (test.file !== lastFile) {
      lines.push(`### ${test.file}`);
      lastFile = test.file;
    }
    lines.push(`**${test.fullName}** — ${test.passed} passed, ${test.failed} failed`);
    lines.push(renderFailedOn(test.failedOn));
    lines.push(renderFailureMessages(test.failureMessages));
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function renderLaneFailures(failures: readonly LaneFailure[]): string {
  const lines = [`## Lane failures (${failures.length})`, ""];
  if (failures.length === 0) {
    lines.push("_None. A lane failure is an infrastructure fault and is never attributed to a test._");
    return lines.join("\n");
  }
  for (const failure of failures) {
    lines.push(`- rep ${failure.repetition} shard ${failure.shard}: ${failure.reason} — ${failure.detail}`);
  }
  return lines.join("\n");
}

export function renderMarkdown(report: FlakeReport): string {
  const seeds = report.profile.seeds;
  const seedRange = seeds.length > 0 ? `${Math.min(...seeds)}–${Math.max(...seeds)}` : "none";
  const nonDeterministic = report.tests.filter((t) => t.category === "non_deterministic");
  const consistentlyFailing = report.tests.filter((t) => t.category === "consistently_failing");

  return [
    `# Flake report — ${report.repetitions} repetitions × ${report.shards} shards`,
    "",
    `Generated ${report.generatedAt}. Profile: \`${report.profile.command}\`, maxWorkers ${report.profile.maxWorkers}, shuffled file order, seeds ${seedRange}.`,
    "",
    `${report.summary.total} tests: ${report.summary.consistentlyPassing} consistently passing, ${report.summary.nonDeterministic} non-deterministic, ${report.summary.consistentlyFailing} consistently failing.`,
    `Lane failures: ${report.laneFailures.length}.`,
    "",
    renderSection("Non-deterministic", nonDeterministic),
    "",
    renderSection("Consistently failing", consistentlyFailing),
    "",
    renderLaneFailures(report.laneFailures),
    "",
  ].join("\n");
}

const JSON_RE = /^rep(\d+)-shard(\d+)\.json$/;
const META_RE = /^rep(\d+)-shard(\d+)\.meta\.json$/;

function parseResult(raw: string): ParsedLane["result"] {
  try {
    const data = JSON.parse(raw) as JsonTestResults;
    if (!Array.isArray(data.testResults) || typeof data.numFailedTests !== "number") {
      return { ok: false, reason: "unparseable", detail: "JSON does not look like a Vitest JsonTestResults object" };
    }
    return { ok: true, data };
  } catch (error) {
    return { ok: false, reason: "unparseable", detail: error instanceof Error ? error.message : String(error) };
  }
}

function parseMeta(raw: string): LaneMeta | null {
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (typeof data.exitCode !== "number") return null;
    return {
      exitCode: data.exitCode,
      seed: typeof data.seed === "number" ? data.seed : 0,
      stderrTail: typeof data.stderrTail === "string" ? data.stderrTail : "",
    };
  } catch {
    return null;
  }
}

/** Reads every `rep<N>-shard<S>.json`/`.meta.json` pair under `inputDir`. The only I/O in this module. */
export function readLanes(inputDir: string): ParsedLane[] {
  interface Slot {
    repetition: number;
    shard: number;
    jsonPath?: string;
    metaPath?: string;
  }
  const slots = new Map<string, Slot>();
  for (const name of readdirSync(inputDir)) {
    const metaMatch = META_RE.exec(name);
    const jsonMatch = metaMatch ? null : JSON_RE.exec(name);
    const match = metaMatch ?? jsonMatch;
    if (!match) continue;
    const key = `${match[1]}-${match[2]}`;
    const slot = slots.get(key) ?? { repetition: Number(match[1]), shard: Number(match[2]) };
    if (metaMatch) slot.metaPath = join(inputDir, name);
    else slot.jsonPath = join(inputDir, name);
    slots.set(key, slot);
  }
  return [...slots.values()].map((slot) => ({
    repetition: slot.repetition,
    shard: slot.shard,
    meta: slot.metaPath ? parseMeta(readFileSync(slot.metaPath, "utf8")) : null,
    result: slot.jsonPath
      ? parseResult(readFileSync(slot.jsonPath, "utf8"))
      : { ok: false, reason: "missing", detail: `no rep${slot.repetition}-shard${slot.shard}.json found` },
  }));
}

export function parseArgs(
  argv: readonly string[],
): { input: string; out: string; repetitions?: number; shards?: number } | null {
  let input: string | null = null;
  let out = ".";
  let repetitions: number | undefined;
  let shards: number | undefined;
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) return null;
    if (flag === "--input") input = value;
    else if (flag === "--out") out = value;
    else if (flag === "--repetitions") {
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) return null;
      repetitions = n;
    } else if (flag === "--shards") {
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) return null;
      shards = n;
    } else {
      return null;
    }
  }
  if (!input) return null;
  return { input, out, repetitions, shards };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed) {
    console.error("Usage: flake:report --input <dir> [--out <dir>] [--repetitions <n>] [--shards <n>]");
    return 1;
  }

  let lanes: ParsedLane[];
  try {
    lanes = readLanes(parsed.input);
  } catch (error) {
    console.error(`Could not read --input ${parsed.input}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  if (lanes.length === 0) {
    console.error(`No lane output found under ${parsed.input}.`);
    return 1;
  }

  const shards = parsed.shards ?? new Set(lanes.map((l) => l.shard)).size;
  const report = buildReport(lanes, {
    repetitions: parsed.repetitions,
    shards: parsed.shards,
    profile: { command: `DOCKET_SKIP_PERF_TESTS=1 pnpm exec vitest run --shard=<s>/${shards}`, maxWorkers: testWorkerCount() },
  });

  try {
    mkdirSync(parsed.out, { recursive: true });
    writeFileSync(join(parsed.out, "flake-report.json"), JSON.stringify(report, null, 2));
    writeFileSync(join(parsed.out, "flake-report.md"), renderMarkdown(report));
  } catch (error) {
    console.error(`Could not write to --out ${parsed.out}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  return 0;
}

// Run only as the entry point; realpath so a symlinked output directory still matches.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
