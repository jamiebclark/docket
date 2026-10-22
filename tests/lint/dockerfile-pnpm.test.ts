import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The image build must reach the npm registry for pnpm itself exactly once, in `base`.
//
// `corepack install` caches the pnpm npm package, but pnpm 12 fetches a separate native binary
// (`@pnpm/exe.<platform>`) the first time it actually runs. Before this was warmed in `base`, the
// `deps` and `build` stages each fetched it themselves, and a slow registry failed the whole image
// build on a 30 s timeout with nothing else wrong — four CI runs on #191 died that way. The
// Dockerfile comment claimed pnpm was fetched once; nothing checked that it was.

const DOCKERFILE = readFileSync("Dockerfile", "utf8");

/** The body of one `FROM … AS <name>` stage, up to the next `FROM`. */
function stage(name: string): string {
  const from = new RegExp(`^FROM\\s+\\S+\\s+AS\\s+${name}\\s*$`, "im");
  const match = from.exec(DOCKERFILE);
  if (!match) throw new Error(`Dockerfile has no stage named ${name}`);
  const rest = DOCKERFILE.slice(match.index + match[0].length);
  const next = /^FROM\s/im.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

/** `RUN` bodies with line continuations folded, so a multi-line command reads as one string. */
function runCommands(body: string): string[] {
  return body
    .replace(/\\\r?\n/g, " ")
    .split(/\r?\n/)
    .filter((line) => /^RUN\s/.test(line.trim()));
}

describe("Dockerfile pnpm provisioning", () => {
  it("runs pnpm in the base stage, so the native binary is baked into that layer", () => {
    const runs = runCommands(stage("base"));
    expect(runs.some((r) => /corepack install/.test(r))).toBe(true);
    // `corepack install` alone does not materialise the native binary — pnpm has to actually run.
    expect(runs.some((r) => /\bpnpm\s+--version\b/.test(r))).toBe(true);
  });

  it("warms pnpm with a package.json in scope, so it caches the pinned version", () => {
    // With no `packageManager` field in sight pnpm resolves the latest release instead, caching a
    // binary no later stage wants and leaving the real one to be fetched again.
    const warm = runCommands(stage("base")).find((r) => /\bpnpm\s+--version\b/.test(r))!;
    expect(warm).toMatch(/package\.json/);
    expect(DOCKERFILE).toMatch(/^COPY\s+package\.json\s/im);
  });

  it("leaves no warm-up directory behind in the image", () => {
    const warm = runCommands(stage("base")).find((r) => /\bpnpm\s+--version\b/.test(r))!;
    const dir = /mkdir\s+-p\s+(\/\S+)/.exec(warm);
    expect(dir, "the warm-up should use a throwaway directory").not.toBeNull();
    expect(warm).toMatch(new RegExp(`rm\\s+-rf\\s+${dir![1]}`));
  });

  it("never re-provisions pnpm in a later stage", () => {
    for (const name of ["deps", "build"]) {
      const runs = runCommands(stage(name));
      expect(runs.some((r) => /corepack (enable|install)/.test(r)), name).toBe(false);
      expect(runs.some((r) => /\bpnpm\s+--version\b/.test(r)), name).toBe(false);
    }
  });

  it("pins the pnpm version in package.json, which is what base caches", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { packageManager?: string };
    expect(pkg.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
  });
});
