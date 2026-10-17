import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `parkAll*` was the workaround family for shared-database leftovers between test files:
 * `parkAllJobs`, `parkAllStandingSeries` (`tests/helpers/jobs-env.ts`), `parkAllEmail`
 * (`tests/helpers/email.ts`), `parkAllEngagementReads`, `parkAllDueTargets`
 * (`tests/helpers/scheduling.ts`). `tests/setup/reset-database.ts` now resets every test's database by
 * default, so no file needs to park another file's rows — the whole family should never come back.
 *
 * The allow-list only shrinks: it is empty now that every caller is migrated, and stays that way.
 */
const ALLOWED: ReadonlySet<string> = new Set();

const ROOT = process.cwd();
const SELF = "tests/lint/no-parking-helpers.test.ts";
const PARK_ALL = /\bparkAll\w*\b/;

function allFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) allFiles(path, out);
    else if (/\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

describe("no file defines, exports or imports a parkAll* symbol", () => {
  const files = allFiles(join(ROOT, "tests")).concat(allFiles(join(ROOT, "src")));

  it("finds the source and test files", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("has no parkAll* symbol outside the allow-list", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = file.slice(ROOT.length + 1).replaceAll("\\", "/");
      if (rel === SELF || ALLOWED.has(rel)) continue;
      const source = readFileSync(file, "utf8");
      if (PARK_ALL.test(source)) offenders.push(rel);
    }
    expect(offenders, `remove the parkAll* symbol (or restore it via drainTicks()/reset-database.ts isolation) in:\n${offenders.join("\n")}`).toEqual([]);
  });
});
