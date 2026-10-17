import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import config from "../../vitest.config";

/**
 * A retried test turns "this is flaky" into "this is green," which is exactly the failure mode this
 * feature exists to remove (FR-007). `retry`/`repeats` default to `0`; this guard keeps them there and
 * keeps any one test from opting back in.
 */

const ROOT = process.cwd();
const SELF = "tests/lint/no-test-retries.test.ts";

function testFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) testFiles(path, out);
    else if (/\.test\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

describe("no test retries", () => {
  it("resolves retry and repeats to 0 in vitest.config.ts", () => {
    const test = (config as { test?: { retry?: number; repeats?: number } }).test ?? {};
    expect(test.retry ?? 0).toBe(0);
    expect(test.repeats ?? 0).toBe(0);
  });

  const files = testFiles(join(ROOT, "tests")).concat(testFiles(join(ROOT, "src")));

  it("finds the test files", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("has no test file passing a retry option to it/describe/test", () => {
    const offenders: string[] = [];
    const callWithRetry = /\b(?:it|describe|test)(?:\.\w+)?\([^)]*\{\s*[^}]*\bretry\s*:\s*[1-9]/;
    for (const file of files) {
      const rel = file.slice(ROOT.length + 1).replaceAll("\\", "/");
      if (rel === SELF) continue;
      const source = readFileSync(file, "utf8");
      if (callWithRetry.test(source)) offenders.push(rel);
    }
    expect(offenders, `remove the retry option (tests must not self-retry):\n${offenders.join("\n")}`).toEqual([]);
  });
});
