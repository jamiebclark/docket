import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Research P21 / SC-007: ffmpeg runs only in the worker. Nothing the web process loads may reach src/server/video/,
// and `node:child_process` has exactly one importer.

const ROOT = process.cwd();
const SRC = join(ROOT, "src");
const VIDEO_DIR = join(SRC, "server", "video");
const SPAWN = join(VIDEO_DIR, "spawn.ts");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const IMPORT = /(?:from|import)\s*\(?\s*["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)/g;

function specifiers(file: string): string[] {
  const src = readFileSync(file, "utf8");
  return [...src.matchAll(IMPORT)].map((m) => (m[1] ?? m[2])!);
}

function resolveLocal(from: string, spec: string): string | null {
  const base = spec.startsWith("@/") ? join(SRC, spec.slice(2)) : spec.startsWith(".") ? resolve(dirname(from), spec) : null;
  if (!base) return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Every file reachable from `entries` through static and dynamic imports, with the path that led there. */
function reachable(entries: string[]): Map<string, string> {
  const seen = new Map<string, string>();
  const queue = entries.filter(existsSync);
  for (const e of queue) seen.set(e, relative(ROOT, e));
  while (queue.length) {
    const file = queue.pop()!;
    for (const spec of specifiers(file)) {
      const target = resolveLocal(file, spec);
      if (target && !seen.has(target)) {
        seen.set(target, `${seen.get(file)} → ${relative(ROOT, target)}`);
        queue.push(target);
      }
    }
  }
  return seen;
}

describe("ffmpeg stays in the worker", () => {
  it("is unreachable from the web entry points", () => {
    const entries = [
      ...walk(join(SRC, "app")),
      join(SRC, "proxy.ts"),
      join(SRC, "instrumentation.ts"),
      join(SRC, "server", "scheduler", "index.ts"),
    ];
    const graph = reachable(entries);
    const leaks = [...graph].filter(([file]) => file.startsWith(`${VIDEO_DIR}/`)).map(([, via]) => via);
    expect(leaks).toEqual([]);
  });

  it("walks the worker entry to the video loop (the walk itself works)", () => {
    const graph = reachable([join(SRC, "worker.ts")]);
    expect([...graph.keys()]).toContain(SPAWN);
  });

  it("allows `node:child_process` in src/server/video/spawn.ts only", () => {
    const importers = walk(SRC).filter((f) => specifiers(f).some((s) => s === "node:child_process" || s === "child_process"));
    expect(importers.map((f) => relative(ROOT, f))).toEqual([relative(ROOT, SPAWN)]);
  });
});
