import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A tick loop bounded by a literal count (`while (… && ticks < 10)`, `for (let i = 0; i < 4; i++)`)
 * passes or fails depending on how much capacity the machine drains per tick, not on whether the work
 * actually finished — fast locally, flaky on a loaded CI runner. `drainTicks()` in `tests/helpers/
 * tick.ts` replaces every one of these: it drives ticks until a caller-supplied predicate holds, with
 * `ceiling` as headroom rather than an expectation (FR-029).
 *
 * This guard forbids introducing another one.
 */

const ROOT = process.cwd();
const SELF = "tests/lint/tick-drain.test.ts";

/**
 * Files with a tick loop bounded by a literal, not yet migrated to `drainTicks()`. Each entry names
 * the line and the reason it is still here. The set only shrinks (see T036).
 */
/**
 * Not yet migrated. T036 sweeps this list down; it exists only because the sweep is a separate task
 * from writing the guard, not because any of these loops are correct as written.
 */
const EXEMPT: ReadonlySet<string> = new Set([
  "tests/integration/api/endpoints/jobs.test.ts",
  "tests/integration/bluesky/images.test.ts",
  "tests/integration/bluesky/video.test.ts",
  "tests/integration/bluesky/video-failures.test.ts",
  "tests/integration/bluesky/video-limits.test.ts",
  "tests/integration/dated-series/idempotency.test.ts",
  "tests/integration/email/failure-pause.test.ts",
  "tests/integration/engagement/ingest.test.ts",
  // (email/tick.test.ts migrated to drainTicks() in T035 — no longer here)
  "tests/integration/facebook/multi-photo.test.ts",
  "tests/integration/facebook/reels.test.ts",
  "tests/integration/generation/brand-context.test.ts",
  "tests/integration/instagram/container-status.test.ts",
  "tests/integration/instagram/quota.test.ts",
  "tests/integration/instagram/reels.test.ts",
  "tests/integration/instagram/stories.test.ts",
  "tests/integration/instagram/video-carousel.test.ts",
  "tests/integration/jobs/credit-hold.test.ts",
  "tests/integration/jobs/credit-outage.test.ts",
  "tests/integration/jobs/credit-probe.test.ts",
  "tests/integration/jobs/external-id-late-skip.test.ts",
  "tests/integration/jobs/fairness.test.ts",
  "tests/integration/jobs/idempotency.test.ts",
  "tests/integration/jobs/isolation.test.ts",
  "tests/integration/jobs/no-secrets.test.ts",
  "tests/integration/jobs/policy.test.ts",
  "tests/integration/jobs/posting-instructions.test.ts",
  "tests/integration/jobs/processing.test.ts",
  "tests/integration/jobs/recovery.test.ts",
  "tests/integration/jobs/ui.test.tsx",
  "tests/integration/llm/per-project-resolution.test.ts",
  "tests/integration/media/video-publish.test.ts",
  "tests/integration/meta/no-secrets.test.ts",
  "tests/integration/scheduler/ambiguous.test.ts",
  "tests/integration/scheduler/concurrency.test.ts",
  "tests/integration/standing-series/self-pause.test.ts",
  "tests/integration/threads/carousel.test.ts",
  "tests/integration/threads/container-status.test.ts",
  "tests/integration/tiktok/failures.test.ts",
  "tests/integration/tiktok/unaudited.test.ts",
  "tests/integration/tiktok/unaudited-ui.test.tsx",
  "tests/integration/tiktok/video.test.ts",
  "tests/integration/x/publish-e2e.test.ts",
]);

function testFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) testFiles(path, out);
    else if (/\.test\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

/** True if `condition` compares a loop variable against a literal integer greater than 1. */
function boundedByLiteralOverOne(condition: string): boolean {
  const matches = condition.matchAll(/<=?\s*(\d+)/g);
  for (const m of matches) {
    if (Number(m[1]) > 1) return true;
  }
  return false;
}

/** The text between a loop header's balanced parens, starting at `open` (the index of `(`). */
function balancedParens(source: string, open: number): { text: string; close: number } {
  let depth = 0;
  let j = open;
  for (; j < source.length; j++) {
    if (source[j] === "(") depth++;
    else if (source[j] === ")") {
      depth--;
      if (depth === 0) break;
    }
  }
  return { text: source.slice(open + 1, j), close: j };
}

/** The loop's body: a balanced-brace block if present, else the single statement up to `;`. */
function loopBody(source: string, afterHeader: number): string {
  let i = afterHeader;
  while (i < source.length && /\s/.test(source[i]!)) i++;
  if (source[i] === "{") {
    let depth = 0;
    let j = i;
    for (; j < source.length; j++) {
      if (source[j] === "{") depth++;
      else if (source[j] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    return source.slice(i, j + 1);
  }
  const semi = source.indexOf(";", i);
  return source.slice(i, semi === -1 ? source.length : semi + 1);
}

const TICK_CALL = /\b(?:runTick|tick\w*)\s*\(/;
const LOOP_HEADER = /\b(while|for)\s*\(/g;

/** Every (loop header text, body text) pair in `source`. */
function loops(source: string): { condition: string; body: string }[] {
  const out: { condition: string; body: string }[] = [];
  for (const m of source.matchAll(LOOP_HEADER)) {
    const open = m.index! + m[0].length - 1;
    const { text, close } = balancedParens(source, open);
    out.push({ condition: text, body: loopBody(source, close + 1) });
  }
  return out;
}

describe("no tick loop is bounded by a literal greater than 1", () => {
  const files = testFiles(join(ROOT, "tests"));

  it("finds the test files", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("has no offending loop outside the exemption set", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = file.slice(ROOT.length + 1).replaceAll("\\", "/");
      if (rel === SELF || EXEMPT.has(rel)) continue;
      const source = readFileSync(file, "utf8");
      if (!TICK_CALL.test(source)) continue;
      for (const { condition, body } of loops(source)) {
        if (boundedByLiteralOverOne(condition) && TICK_CALL.test(body)) {
          offenders.push(`${rel}: loop(${condition.trim().slice(0, 60)}) calls a tick inside`);
        }
      }
    }
    expect(
      offenders,
      `replace with drainTicks() from tests/helpers/tick.ts (or add a one-line-reasoned exemption):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
