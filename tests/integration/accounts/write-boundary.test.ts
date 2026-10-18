import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// FR-010: grantedScopes is written in exactly two places — the connect write boundary and the
// refresh write boundary — never anywhere else (data-model.md §2).

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
  }
  return out;
}

/** True for an object-literal write position (`grantedScopes: value` or shorthand `grantedScopes,`),
 * false for a type annotation, a drizzle column definition, a destructure, or a read reference. */
function isWriteLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === "grantedScopes," || trimmed === "grantedScopes") return true;
  const m = /\bgrantedScopes\s*:\s*(\S+)/.exec(trimmed);
  if (!m) return false;
  const value = m[1]!;
  // Exclude a read that passes the same field through unchanged (e.g. `grantedScopes: a.grantedScopes`) —
  // a write assigns a distinct, already-computed value.
  return !/^readonly$/.test(value) && !/^text\(/.test(value) && !/grantedScopes/.test(value);
}

describe("the write boundary for grantedScopes (FR-010)", () => {
  it("is written in an insert/update position in exactly dal/accounts.ts and scheduler/credentials.ts", () => {
    const sites = walk(SRC)
      .filter((file) => readFileSync(file, "utf8").split("\n").some(isWriteLine))
      .map((file) => relative(ROOT, file).replace(/\\/g, "/"))
      .sort();

    expect(sites).toEqual(["src/server/dal/accounts.ts", "src/server/scheduler/credentials.ts"].sort());
  });
});
