import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

function specifiers(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const out: string[] = [];
  for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)["']([^"']+)["']/g)) out.push(m[1]!);
  return out;
}

const isTest = (f: string) => /\.test\.tsx?$/.test(f);

// The first lintText call loads the full Next ESLint config; a cold start can exceed
// Vitest\'s 5 s default on a busy machine or CI runner.
describe("import boundaries", { timeout: 30_000 }, () => {
  it("src/providers/** imports nothing from src/server/**", () => {
    const bad = files("src/providers")
      .filter((f) => !isTest(f))
      .flatMap((f) => specifiers(f).filter((s) => /(^@\/server\b)|(\/server(\/|$))/.test(s)).map((s) => `${f}: ${s}`));
    expect(bad).toEqual([]);
  });

  it("src/server/scheduler/** and src/worker.ts import no next/*", () => {
    const targets = [...files("src/server/scheduler"), "src/worker.ts"].filter((f) => !isTest(f));
    expect(targets.length).toBeGreaterThan(1);
    const bad = targets.flatMap((f) => specifiers(f).filter((s) => s === "next" || s.startsWith("next/")).map((s) => `${f}: ${s}`));
    expect(bad).toEqual([]);
  });
});
